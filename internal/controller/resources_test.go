package controller

import (
	"testing"

	corev1 "k8s.io/api/core/v1"
	rbacv1 "k8s.io/api/rbac/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/types"
	"k8s.io/apimachinery/pkg/util/validation"
	gatewayv1 "sigs.k8s.io/gateway-api/apis/v1"
)

const (
	testGatewayName      = "test-gw"
	testGatewayNamespace = "default"
	testDeploymentName   = "portail-test-gw"
	testOwnerKindGateway = "Gateway"
)

func TestResourceNameLongGatewayName(t *testing.T) {
	// "portail-" + this 57-char name = 65 chars, over the 63-char DNS-1123 limit.
	long := "gateway-with-one-not-matching-port-and-section-name-route"
	name, err := resourceName(long)
	if err != nil {
		t.Fatalf("resourceName returned error for long gateway name: %v", err)
	}
	if errs := validation.IsDNS1123Label(name); len(errs) > 0 {
		t.Fatalf("resourceName %q (%d chars) is not a valid DNS-1123 label: %v", name, len(name), errs)
	}
	if got, _ := resourceName(long); got != name {
		t.Fatalf("resourceName is not deterministic: %q != %q", got, name)
	}
}

func testGateway() *gatewayv1.Gateway {
	return &gatewayv1.Gateway{
		ObjectMeta: metav1.ObjectMeta{
			Name:      testGatewayName,
			Namespace: testGatewayNamespace,
			UID:       types.UID("test-uid-1234"),
		},
		Spec: gatewayv1.GatewaySpec{
			GatewayClassName: "portail",
			Listeners: []gatewayv1.Listener{
				{
					Name:     "http",
					Port:     80,
					Protocol: gatewayv1.HTTPProtocolType,
				},
				{
					Name:     "https",
					Port:     443,
					Protocol: gatewayv1.HTTPSProtocolType,
				},
			},
		},
	}
}

func TestDerivePorts(t *testing.T) {
	gw := testGateway()
	ports := DerivePorts(gw)

	if len(ports) != 2 {
		t.Fatalf("expected 2 ports, got %d", len(ports))
	}
	if ports[0].Port != 80 || ports[0].Protocol != corev1.ProtocolTCP {
		t.Errorf("port 0: expected 80/TCP, got %d/%s", ports[0].Port, ports[0].Protocol)
	}
	if ports[1].Port != 443 || ports[1].Protocol != corev1.ProtocolTCP {
		t.Errorf("port 1: expected 443/TCP, got %d/%s", ports[1].Port, ports[1].Protocol)
	}
}

func TestDerivePortsDedup(t *testing.T) {
	gw := &gatewayv1.Gateway{
		Spec: gatewayv1.GatewaySpec{
			Listeners: []gatewayv1.Listener{
				{Name: "http", Port: 80, Protocol: gatewayv1.HTTPProtocolType},
				{Name: "http-alt", Port: 80, Protocol: gatewayv1.HTTPProtocolType},
				{Name: "https", Port: 443, Protocol: gatewayv1.HTTPSProtocolType},
			},
		},
	}
	ports := DerivePorts(gw)
	if len(ports) != 2 {
		t.Fatalf("expected 2 ports after dedup, got %d", len(ports))
	}
}

func TestDerivePortsUDP(t *testing.T) {
	gw := &gatewayv1.Gateway{
		Spec: gatewayv1.GatewaySpec{
			Listeners: []gatewayv1.Listener{
				{Name: "dns", Port: 5300, Protocol: gatewayv1.UDPProtocolType},
				{Name: "http", Port: 80, Protocol: gatewayv1.HTTPProtocolType},
			},
		},
	}
	ports := DerivePorts(gw)
	if len(ports) != 2 {
		t.Fatalf("expected 2 ports, got %d", len(ports))
	}
	if ports[0].Protocol != corev1.ProtocolUDP {
		t.Errorf("expected UDP for dns port, got %s", ports[0].Protocol)
	}
	if ports[1].Protocol != corev1.ProtocolTCP {
		t.Errorf("expected TCP for http port, got %s", ports[1].Protocol)
	}
}

func TestAllocateTargetPorts(t *testing.T) {
	dp := func(ps ...int32) []DerivedPort {
		out := make([]DerivedPort, 0, len(ps))
		for _, p := range ps {
			out = append(out, DerivedPort{Port: p})
		}
		return out
	}

	t.Run("privileged draw from pool, unprivileged bind themselves", func(t *testing.T) {
		got := allocateTargetPorts(dp(80, 443, 8080), nil)
		if got[8080] != 8080 {
			t.Errorf("expected 8080->8080, got %d", got[8080])
		}
		if got[80] <= privilegedPortMax || got[443] <= privilegedPortMax {
			t.Errorf("expected unprivileged targets, got 80=%d 443=%d", got[80], got[443])
		}
		if got[80] == got[443] {
			t.Errorf("expected distinct targets, got %d for both", got[80])
		}
	})

	t.Run("pool avoids an unprivileged listener's port", func(t *testing.T) {
		got := allocateTargetPorts(dp(80, 8080), nil)
		if got[80] == 8080 {
			t.Error("expected 80 not to collide with the 8080 listener")
		}
		if got[8080] != 8080 {
			t.Errorf("expected 8080->8080, got %d", got[8080])
		}
	})

	t.Run("existing assignments are preserved", func(t *testing.T) {
		// Adding a lower port (70) must not move the existing 80/90 targets.
		got := allocateTargetPorts(dp(70, 80, 90), map[int32]int32{80: 8000, 90: 8001})
		if got[80] != 8000 || got[90] != 8001 {
			t.Errorf("expected 80->8000, 90->8001 preserved, got 80=%d 90=%d", got[80], got[90])
		}
		if got[70] == 8000 || got[70] == 8001 || got[70] <= privilegedPortMax {
			t.Errorf("expected 70 to get a fresh unprivileged target, got %d", got[70])
		}
	})

	t.Run("deterministic regardless of listener order", func(t *testing.T) {
		a := allocateTargetPorts(dp(80, 443, 22), nil)
		b := allocateTargetPorts(dp(22, 443, 80), nil)
		for _, p := range []int32{22, 80, 443} {
			if a[p] != b[p] {
				t.Errorf("non-deterministic for %d: %d vs %d", p, a[p], b[p])
			}
		}
	})
}

func TestBuildDeployment(t *testing.T) {
	gw := testGateway()
	deploy, err := BuildDeployment(gw, "ghcr.io/epheo/portail:latest", "portail.epheo.eu/gateway-controller", "portail-controller", 2, nil)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	if *deploy.Name != testDeploymentName {
		t.Errorf("expected name portail-test-gw, got %s", *deploy.Name)
	}
	if *deploy.Namespace != testGatewayNamespace {
		t.Errorf("expected namespace default, got %s", *deploy.Namespace)
	}
	if *deploy.Spec.Replicas != 2 {
		t.Errorf("expected 2 replicas, got %d", *deploy.Spec.Replicas)
	}

	// Check owner reference
	if len(deploy.OwnerReferences) != 1 {
		t.Fatalf("expected 1 owner reference, got %d", len(deploy.OwnerReferences))
	}
	ownerRef := deploy.OwnerReferences[0]
	if *ownerRef.Kind != testOwnerKindGateway {
		t.Errorf("expected owner kind Gateway, got %s", *ownerRef.Kind)
	}
	if *ownerRef.Name != testGatewayName {
		t.Errorf("expected owner name test-gw, got %s", *ownerRef.Name)
	}
	if *ownerRef.Controller != true {
		t.Error("expected controller=true on owner reference")
	}

	// Check container
	containers := deploy.Spec.Template.Spec.Containers
	if len(containers) != 1 {
		t.Fatalf("expected 1 container, got %d", len(containers))
	}
	c := containers[0]
	if *c.Image != "ghcr.io/epheo/portail:latest" {
		t.Errorf("expected image ghcr.io/epheo/portail:latest, got %s", *c.Image)
	}
	// Container ports are intentionally not declared (informational only) so listener
	// changes don't churn the pod template.
	if len(c.Ports) != 0 {
		t.Errorf("expected no declared container ports, got %d", len(c.Ports))
	}
	if c.SecurityContext.Capabilities.Drop[0] != "ALL" {
		t.Error("expected capabilities drop ALL")
	}
	// LoadBalancer mode (no networks): the data plane binds unprivileged target ports,
	// so no NET_BIND_SERVICE is added.
	if len(c.SecurityContext.Capabilities.Add) != 0 {
		t.Errorf("expected no added capabilities in LoadBalancer mode, got %v", c.SecurityContext.Capabilities.Add)
	}

	// Check labels
	if deploy.Labels["portail.epheo.eu/gateway"] != testGatewayName {
		t.Error("missing gateway label on deployment")
	}
}

func TestBuildService(t *testing.T) {
	gw := testGateway()
	ports := DerivePorts(gw)
	targets := allocateTargetPorts(ports, nil)
	svc, err := BuildService(gw, ports, targets)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	if *svc.Name != testDeploymentName {
		t.Errorf("expected name portail-test-gw, got %s", *svc.Name)
	}
	if *svc.Spec.Type != corev1.ServiceTypeLoadBalancer {
		t.Errorf("expected LoadBalancer type, got %s", *svc.Spec.Type)
	}
	if len(svc.Spec.Ports) != 2 {
		t.Fatalf("expected 2 service ports, got %d", len(svc.Spec.Ports))
	}
	if *svc.Spec.Ports[0].Port != 80 {
		t.Errorf("expected port 80, got %d", *svc.Spec.Ports[0].Port)
	}
	// Privileged published port 80 is served on an unprivileged target port.
	if tp := svc.Spec.Ports[0].TargetPort.IntValue(); int32(tp) <= privilegedPortMax {
		t.Errorf("expected unprivileged targetPort for published 80, got %d", tp)
	}
	if svc.Spec.Selector["portail.epheo.eu/gateway"] != testGatewayName {
		t.Error("missing gateway selector on service")
	}

	// Check owner reference
	if len(svc.OwnerReferences) != 1 {
		t.Fatalf("expected 1 owner reference, got %d", len(svc.OwnerReferences))
	}
	if *svc.OwnerReferences[0].Kind != testOwnerKindGateway {
		t.Errorf("expected owner kind Gateway, got %s", *svc.OwnerReferences[0].Kind)
	}
}

func TestExtractNetworkNames(t *testing.T) {
	netType := NetworkAddressType
	ipType := gatewayv1.IPAddressType

	tests := []struct {
		name      string
		addresses []gatewayv1.GatewaySpecAddress
		want      []string
	}{
		{"no addresses", nil, nil},
		{"only IP addresses", []gatewayv1.GatewaySpecAddress{
			{Type: &ipType, Value: "10.0.0.1"},
		}, nil},
		{"two network addresses", []gatewayv1.GatewaySpecAddress{
			{Type: &netType, Value: "udn-frontend"},
			{Type: &netType, Value: "udn-backend"},
		}, []string{"udn-frontend", "udn-backend"}},
		{"deduplication", []gatewayv1.GatewaySpecAddress{
			{Type: &netType, Value: "udn-frontend"},
			{Type: &netType, Value: "udn-frontend"},
		}, []string{"udn-frontend"}},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			gw := &gatewayv1.Gateway{
				Spec: gatewayv1.GatewaySpec{Addresses: tt.addresses},
			}
			got, err := ExtractNetworkNames(gw)
			if err != nil {
				t.Fatalf("unexpected error: %v", err)
			}
			if len(got) != len(tt.want) {
				t.Fatalf("ExtractNetworkNames() returned %d names, want %d", len(got), len(tt.want))
			}
			for i := range got {
				if got[i] != tt.want[i] {
					t.Errorf("ExtractNetworkNames()[%d] = %q, want %q", i, got[i], tt.want[i])
				}
			}
		})
	}
}

func TestBuildServiceAccount(t *testing.T) {
	sa := BuildServiceAccount(testGatewayNamespace, "portail-controller")

	if *sa.Name != "portail-controller" {
		t.Errorf("expected SA name %q, got %q", "portail-controller", *sa.Name)
	}
	if *sa.Namespace != testGatewayNamespace {
		t.Errorf("expected SA namespace %q, got %q", testGatewayNamespace, *sa.Namespace)
	}
	if sa.Labels["app.kubernetes.io/managed-by"] != "portail-operator" {
		t.Errorf("expected managed-by label, got %v", sa.Labels)
	}
	if len(sa.OwnerReferences) != 0 {
		t.Errorf("expected no ownerReferences on shared SA, got %v", sa.OwnerReferences)
	}
}

func TestBuildClusterRoleBinding(t *testing.T) {
	subjects := []rbacv1.Subject{
		{Kind: "ServiceAccount", Name: "portail-controller", Namespace: testGatewayNamespace},
		{Kind: "ServiceAccount", Name: "portail-controller", Namespace: "production"},
	}
	crb := BuildClusterRoleBinding("portail-operator-dataplane-role", subjects)

	if *crb.Name != ClusterRoleBindingName {
		t.Errorf("expected name %q, got %q", ClusterRoleBindingName, *crb.Name)
	}
	if *crb.RoleRef.Name != "portail-operator-dataplane-role" {
		t.Errorf("expected roleRef name %q, got %q", "portail-operator-dataplane-role", *crb.RoleRef.Name)
	}
	if *crb.RoleRef.Kind != "ClusterRole" {
		t.Errorf("expected roleRef kind ClusterRole, got %q", *crb.RoleRef.Kind)
	}
	if len(crb.Subjects) != 2 {
		t.Fatalf("expected 2 subjects, got %d", len(crb.Subjects))
	}
	if *crb.Subjects[0].Namespace != testGatewayNamespace || *crb.Subjects[1].Namespace != "production" {
		t.Errorf("unexpected subject namespaces: %v", crb.Subjects)
	}
}

func TestBuildDeploymentMultiNetwork(t *testing.T) {
	gw := testGateway()
	networks := []string{"udn-frontend", "udn-backend"}
	deploy, err := BuildDeployment(gw, "ghcr.io/epheo/portail:latest", "portail.epheo.eu/gateway-controller", "portail-controller", 2, networks)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	// Check CNI annotation on pod template
	ann := deploy.Spec.Template.Annotations
	if ann == nil {
		t.Fatal("expected pod template annotations, got nil")
	}
	expected := "udn-frontend, udn-backend"
	if ann["k8s.v1.cni.cncf.io/networks"] != expected {
		t.Errorf("expected CNI annotation %q, got %q", expected, ann["k8s.v1.cni.cncf.io/networks"])
	}

	// Multi-network mode binds the published port directly, so NET_BIND_SERVICE is added.
	add := deploy.Spec.Template.Spec.Containers[0].SecurityContext.Capabilities.Add
	if len(add) != 1 || add[0] != "NET_BIND_SERVICE" {
		t.Errorf("expected NET_BIND_SERVICE in multi-network mode, got %v", add)
	}
}

func TestBuildDeploymentNoNetworks(t *testing.T) {
	gw := testGateway()
	deploy, err := BuildDeployment(gw, "ghcr.io/epheo/portail:latest", "portail.epheo.eu/gateway-controller", "portail-controller", 2, nil)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	// No CNI annotation when networks is nil
	ann := deploy.Spec.Template.Annotations
	if ann != nil {
		t.Errorf("expected no pod template annotations, got %v", ann)
	}
}

func TestExtractNetworkNamesInvalid(t *testing.T) {
	netType := NetworkAddressType

	tests := []struct {
		name  string
		value string
	}{
		{"empty name", ""},
		{"contains comma", "net-a,net-b"},
		{"contains space", "net a"},
		{"uppercase", "Net-Frontend"},
		{"starts with dash", "-frontend"},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			gw := &gatewayv1.Gateway{
				Spec: gatewayv1.GatewaySpec{
					Addresses: []gatewayv1.GatewaySpecAddress{
						{Type: &netType, Value: tt.value},
					},
				},
			}
			_, err := ExtractNetworkNames(gw)
			if err == nil {
				t.Errorf("expected error for network name %q, got nil", tt.value)
			}
		})
	}
}

func TestBuildDeploymentInvalidGatewayName(t *testing.T) {
	gw := &gatewayv1.Gateway{
		ObjectMeta: metav1.ObjectMeta{
			Name:      "INVALID_NAME!",
			Namespace: testGatewayNamespace,
		},
		Spec: gatewayv1.GatewaySpec{
			Listeners: []gatewayv1.Listener{
				{Name: "http", Port: 80, Protocol: gatewayv1.HTTPProtocolType},
			},
		},
	}
	_, err := BuildDeployment(gw, "image:latest", "controller", "sa", 1, nil)
	if err == nil {
		t.Error("expected error for invalid gateway name, got nil")
	}
}

func TestBuildPodDisruptionBudget(t *testing.T) {
	gw := testGateway()
	pdb, err := BuildPodDisruptionBudget(gw)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	if *pdb.Name != testDeploymentName {
		t.Errorf("expected name portail-test-gw, got %s", *pdb.Name)
	}
	if *pdb.Namespace != testGatewayNamespace {
		t.Errorf("expected namespace default, got %s", *pdb.Namespace)
	}
	if pdb.Spec.MaxUnavailable == nil || pdb.Spec.MaxUnavailable.IntValue() != 1 {
		t.Errorf("expected maxUnavailable=1, got %v", pdb.Spec.MaxUnavailable)
	}
	if pdb.Spec.Selector == nil || pdb.Spec.Selector.MatchLabels["portail.epheo.eu/gateway"] != testGatewayName {
		t.Error("missing gateway selector on PDB")
	}

	// Check owner reference
	if len(pdb.OwnerReferences) != 1 {
		t.Fatalf("expected 1 owner reference, got %d", len(pdb.OwnerReferences))
	}
	if *pdb.OwnerReferences[0].Kind != testOwnerKindGateway {
		t.Errorf("expected owner kind Gateway, got %s", *pdb.OwnerReferences[0].Kind)
	}
}

func TestBuildServiceInvalidGatewayName(t *testing.T) {
	gw := &gatewayv1.Gateway{
		ObjectMeta: metav1.ObjectMeta{
			Name:      "INVALID_NAME!",
			Namespace: testGatewayNamespace,
		},
		Spec: gatewayv1.GatewaySpec{
			Listeners: []gatewayv1.Listener{
				{Name: "http", Port: 80, Protocol: gatewayv1.HTTPProtocolType},
			},
		},
	}
	ports := DerivePorts(gw)
	_, err := BuildService(gw, ports, nil)
	if err == nil {
		t.Error("expected error for invalid gateway name, got nil")
	}
}
