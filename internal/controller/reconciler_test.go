package controller

import (
	"testing"

	appsv1 "k8s.io/api/apps/v1"
	corev1 "k8s.io/api/core/v1"
	policyv1 "k8s.io/api/policy/v1"
	rbacv1 "k8s.io/api/rbac/v1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	apimeta "k8s.io/apimachinery/pkg/api/meta"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/types"
	"k8s.io/client-go/tools/events"
	ctrl "sigs.k8s.io/controller-runtime"
	"sigs.k8s.io/controller-runtime/pkg/client"
	"sigs.k8s.io/controller-runtime/pkg/controller/controllerutil"
	gatewayv1 "sigs.k8s.io/gateway-api/apis/v1"
)

const (
	netFrontend = "udn-frontend"
	netBackend  = "udn-backend"
)

// --- reconciler factories -------------------------------------------------

func newGatewayReconciler() *GatewayReconciler {
	return &GatewayReconciler{
		Client:             envClient,
		Scheme:             envScheme,
		Recorder:           events.NewFakeRecorder(10000),
		ControllerName:     testControllerName,
		Image:              testImage,
		Replicas:           testReplicas,
		ServiceAccountName: testSAName,
	}
}

func newGatewayClassReconciler() *GatewayClassReconciler {
	return &GatewayClassReconciler{
		Client:         envClient,
		Scheme:         envScheme,
		Recorder:       events.NewFakeRecorder(10000),
		ControllerName: testControllerName,
	}
}

func newDataPlaneRBACReconciler() *DataPlaneRBACReconciler {
	return &DataPlaneRBACReconciler{
		Client:             envClient,
		Scheme:             envScheme,
		ControllerName:     testControllerName,
		ServiceAccountName: testSAName,
		DataplaneRoleName:  testDataplaneRoleName,
	}
}

// --- object helpers -------------------------------------------------------

func dpName(gateway string) string { return "portail-" + gateway }

func httpGateway(name, namespace string) *gatewayv1.Gateway {
	return &gatewayv1.Gateway{
		ObjectMeta: metav1.ObjectMeta{Name: name, Namespace: namespace},
		Spec: gatewayv1.GatewaySpec{
			GatewayClassName: testGatewayClass,
			// Two HTTP listeners (no TLS) keep the object clear of the
			// HTTPS-requires-tls CEL validation while still exercising
			// multi-port derivation.
			Listeners: []gatewayv1.Listener{
				{Name: "http", Port: 80, Protocol: gatewayv1.HTTPProtocolType},
				{Name: "http-alt", Port: 8080, Protocol: gatewayv1.HTTPProtocolType},
			},
		},
	}
}

func networkGateway(name, namespace string, networks ...string) *gatewayv1.Gateway {
	gw := httpGateway(name, namespace)
	netType := NetworkAddressType
	for _, n := range networks {
		gw.Spec.Addresses = append(gw.Spec.Addresses, gatewayv1.GatewaySpecAddress{Type: &netType, Value: n})
	}
	return gw
}

func ensureNamespace(t *testing.T, name string) {
	t.Helper()
	ns := &corev1.Namespace{ObjectMeta: metav1.ObjectMeta{Name: name}}
	if err := envClient.Create(t.Context(), ns); err != nil && !apierrors.IsAlreadyExists(err) {
		t.Fatalf("creating namespace %s: %v", name, err)
	}
}

func ensureGatewayClass(t *testing.T) {
	t.Helper()
	gc := &gatewayv1.GatewayClass{
		ObjectMeta: metav1.ObjectMeta{Name: testGatewayClass},
		Spec:       gatewayv1.GatewayClassSpec{ControllerName: gatewayv1.GatewayController(testControllerName)},
	}
	if err := envClient.Create(t.Context(), gc); err != nil && !apierrors.IsAlreadyExists(err) {
		t.Fatalf("creating GatewayClass: %v", err)
	}
}

func createGateway(t *testing.T, gw *gatewayv1.Gateway) {
	t.Helper()
	if err := envClient.Create(t.Context(), gw); err != nil {
		t.Fatalf("creating gateway %s/%s: %v", gw.Namespace, gw.Name, err)
	}
}

func getGateway(t *testing.T, namespace, name string) *gatewayv1.Gateway {
	t.Helper()
	var gw gatewayv1.Gateway
	if err := envClient.Get(t.Context(), types.NamespacedName{Namespace: namespace, Name: name}, &gw); err != nil {
		t.Fatalf("getting gateway %s/%s: %v", namespace, name, err)
	}
	return &gw
}

func mustReconcile(t *testing.T, r *GatewayReconciler, namespace, name string) {
	t.Helper()
	req := ctrl.Request{NamespacedName: types.NamespacedName{Namespace: namespace, Name: name}}
	if _, err := r.Reconcile(t.Context(), req); err != nil {
		t.Fatalf("reconcile %s/%s: %v", namespace, name, err)
	}
}

// mustReconcileRBAC runs the singleton data-plane RBAC reconciler once.
func mustReconcileRBAC(t *testing.T) {
	t.Helper()
	rr := newDataPlaneRBACReconciler()
	if _, err := rr.Reconcile(t.Context(), ctrl.Request{NamespacedName: rbacSingletonKey}); err != nil {
		t.Fatalf("reconcile dataplane RBAC: %v", err)
	}
}

// cleanupAllGateways removes every Gateway (clearing finalizers first) and the
// shared data-plane ClusterRoleBinding, giving each test a clean cluster-global
// slate. The CRB and the Gateway list are cluster-scoped, so without this the
// RBAC aggregation tests would observe Gateways left over from earlier tests.
func cleanupAllGateways(t *testing.T) {
	t.Helper()
	ctx := t.Context()
	var list gatewayv1.GatewayList
	if err := envClient.List(ctx, &list); err != nil {
		t.Fatalf("listing gateways for cleanup: %v", err)
	}
	for i := range list.Items {
		gw := &list.Items[i]
		if len(gw.Finalizers) > 0 {
			gw.Finalizers = nil
			if err := envClient.Update(ctx, gw); err != nil && !apierrors.IsNotFound(err) && !apierrors.IsConflict(err) {
				t.Fatalf("clearing finalizers on %s/%s: %v", gw.Namespace, gw.Name, err)
			}
		}
		if err := envClient.Delete(ctx, gw); err != nil && !apierrors.IsNotFound(err) {
			t.Fatalf("deleting gateway %s/%s: %v", gw.Namespace, gw.Name, err)
		}
	}
	crb := &rbacv1.ClusterRoleBinding{ObjectMeta: metav1.ObjectMeta{Name: ClusterRoleBindingName}}
	if err := envClient.Delete(ctx, crb); err != nil && !apierrors.IsNotFound(err) {
		t.Fatalf("deleting clusterrolebinding: %v", err)
	}
}

// deleteAndConverge deletes a Gateway and drives reconciliation until the
// data-plane RBAC reflects its removal. The driving mechanism (finalizer-based
// cleanup in GatewayReconciler today) is isolated here so the RBAC assertions
// stay stable when the cleanup path is refactored.
func deleteAndConverge(t *testing.T, namespace, name string) {
	t.Helper()
	gw := getGateway(t, namespace, name)
	if err := envClient.Delete(t.Context(), gw); err != nil {
		t.Fatalf("deleting gateway %s/%s: %v", namespace, name, err)
	}
	// No finalizer: the Gateway is gone at once. The singleton RBAC reconciler
	// recomputes the shared binding and prunes the now-orphaned ServiceAccount.
	mustReconcileRBAC(t)
}

// --- assertion helpers ----------------------------------------------------

func conditionStatus(conds []metav1.Condition, condType string) metav1.ConditionStatus {
	if c := apimeta.FindStatusCondition(conds, condType); c != nil {
		return c.Status
	}
	return ""
}

func crbSubjectNamespaces(t *testing.T, c client.Client) map[string]bool {
	t.Helper()
	out := map[string]bool{}
	var crb rbacv1.ClusterRoleBinding
	err := c.Get(t.Context(), types.NamespacedName{Name: ClusterRoleBindingName}, &crb)
	if apierrors.IsNotFound(err) {
		return out
	}
	if err != nil {
		t.Fatalf("getting ClusterRoleBinding: %v", err)
	}
	for _, s := range crb.Subjects {
		out[s.Namespace] = true
	}
	return out
}

func argsContainPair(args []string, flag, value string) bool {
	for i := 0; i+1 < len(args); i++ {
		if args[i] == flag && args[i+1] == value {
			return true
		}
	}
	return false
}

// --- tests ----------------------------------------------------------------

func serviceTargetPorts(t *testing.T, namespace, name string) map[int32]int32 {
	t.Helper()
	var svc corev1.Service
	if err := envClient.Get(t.Context(), types.NamespacedName{Namespace: namespace, Name: name}, &svc); err != nil {
		t.Fatalf("getting service %s/%s: %v", namespace, name, err)
	}
	out := map[int32]int32{}
	for _, p := range svc.Spec.Ports {
		out[p.Port] = int32(p.TargetPort.IntValue())
	}
	return out
}

func deploymentAddedCaps(t *testing.T, namespace, name string) []corev1.Capability {
	t.Helper()
	var dep appsv1.Deployment
	if err := envClient.Get(t.Context(), types.NamespacedName{Namespace: namespace, Name: name}, &dep); err != nil {
		t.Fatalf("getting deployment %s/%s: %v", namespace, name, err)
	}
	sc := dep.Spec.Template.Spec.Containers[0].SecurityContext
	if sc == nil || sc.Capabilities == nil {
		return nil
	}
	return sc.Capabilities.Add
}

func TestReconcileLoadBalancerMode(t *testing.T) {
	c := requireEnvtest(t)
	cleanupAllGateways(t)
	ensureGatewayClass(t)
	ns := "lb-mode"
	ensureNamespace(t, ns)
	createGateway(t, httpGateway("web", ns))

	r := newGatewayReconciler()
	mustReconcile(t, r, ns, "web")
	mustReconcileRBAC(t)

	ctx := t.Context()
	name := dpName("web")

	var dep appsv1.Deployment
	if err := c.Get(ctx, types.NamespacedName{Namespace: ns, Name: name}, &dep); err != nil {
		t.Fatalf("deployment not created: %v", err)
	}
	if *dep.Spec.Replicas != testReplicas {
		t.Errorf("expected %d replicas, got %d", testReplicas, *dep.Spec.Replicas)
	}
	if !argsContainPair(dep.Spec.Template.Spec.Containers[0].Args, "--gateway", ns+"/web") {
		t.Errorf("expected data plane scoped to %s/web, args=%v", ns, dep.Spec.Template.Spec.Containers[0].Args)
	}

	var svc corev1.Service
	if err := c.Get(ctx, types.NamespacedName{Namespace: ns, Name: name}, &svc); err != nil {
		t.Fatalf("service not created: %v", err)
	}
	if svc.Spec.Type != corev1.ServiceTypeLoadBalancer {
		t.Errorf("expected LoadBalancer service, got %s", svc.Spec.Type)
	}
	if len(svc.Spec.Ports) != 2 {
		t.Errorf("expected 2 service ports, got %d", len(svc.Spec.Ports))
	}
	// Privileged published port 80 → a distinct unprivileged target; the already
	// unprivileged 8080 listener keeps its own port.
	targets := serviceTargetPorts(t, ns, name)
	if targets[80] <= privilegedPortMax || targets[80] == 8080 {
		t.Errorf("expected published 80 mapped to a distinct unprivileged target, got %d", targets[80])
	}
	if targets[8080] != 8080 {
		t.Errorf("expected published 8080 to keep target 8080, got %d", targets[8080])
	}
	// LoadBalancer mode binds unprivileged targets → no NET_BIND_SERVICE.
	if caps := deploymentAddedCaps(t, ns, name); len(caps) != 0 {
		t.Errorf("expected no added capabilities in LoadBalancer mode, got %v", caps)
	}

	var pdb policyv1.PodDisruptionBudget
	if err := c.Get(ctx, types.NamespacedName{Namespace: ns, Name: name}, &pdb); err != nil {
		t.Fatalf("pdb not created: %v", err)
	}

	var sa corev1.ServiceAccount
	if err := c.Get(ctx, types.NamespacedName{Namespace: ns, Name: testSAName}, &sa); err != nil {
		t.Fatalf("service account not created: %v", err)
	}

	if subjects := crbSubjectNamespaces(t, c); !subjects[ns] {
		t.Errorf("expected CRB subject for namespace %s, got %v", ns, subjects)
	}

	gw := getGateway(t, ns, "web")
	if got := conditionStatus(gw.Status.Conditions, string(gatewayv1.GatewayConditionAccepted)); got != metav1.ConditionTrue {
		t.Errorf("expected Accepted=True, got %q", got)
	}
	// envtest has no kubelet, so the Deployment never reports available replicas.
	if got := conditionStatus(gw.Status.Conditions, string(gatewayv1.GatewayConditionProgrammed)); got != metav1.ConditionFalse {
		t.Errorf("expected Programmed=False in envtest, got %q", got)
	}
}

func TestReconcileMultiNetworkMode(t *testing.T) {
	c := requireEnvtest(t)
	cleanupAllGateways(t)
	ensureGatewayClass(t)
	ns := "multinet-mode"
	ensureNamespace(t, ns)
	createGateway(t, networkGateway("mesh", ns, netFrontend, netBackend))

	r := newGatewayReconciler()
	mustReconcile(t, r, ns, "mesh")

	ctx := t.Context()
	name := dpName("mesh")

	var dep appsv1.Deployment
	if err := c.Get(ctx, types.NamespacedName{Namespace: ns, Name: name}, &dep); err != nil {
		t.Fatalf("deployment not created: %v", err)
	}
	if got := dep.Spec.Template.Annotations["k8s.v1.cni.cncf.io/networks"]; got != netFrontend+", "+netBackend {
		t.Errorf("unexpected CNI annotation: %q", got)
	}
	// No Service fronts a multi-network pod, so it binds the published port directly
	// and needs NET_BIND_SERVICE.
	if caps := deploymentAddedCaps(t, ns, name); len(caps) != 1 || caps[0] != "NET_BIND_SERVICE" {
		t.Errorf("expected NET_BIND_SERVICE in multi-network mode, got %v", caps)
	}

	var svc corev1.Service
	if err := c.Get(ctx, types.NamespacedName{Namespace: ns, Name: name}, &svc); !apierrors.IsNotFound(err) {
		t.Errorf("expected no Service in multi-network mode, got err=%v", err)
	}

	gw := getGateway(t, ns, "mesh")
	if got := conditionStatus(gw.Status.Conditions, string(gatewayv1.GatewayConditionAccepted)); got != metav1.ConditionTrue {
		t.Errorf("expected Accepted=True, got %q", got)
	}
	gotNets := map[string]bool{}
	for _, a := range gw.Status.Addresses {
		if a.Type != nil && *a.Type == NetworkAddressType {
			gotNets[a.Value] = true
		}
	}
	if !gotNets[netFrontend] || !gotNets[netBackend] {
		t.Errorf("expected network addresses %s,%s, got %+v", netFrontend, netBackend, gw.Status.Addresses)
	}
}

func TestReconcileServiceModeTransition(t *testing.T) {
	c := requireEnvtest(t)
	cleanupAllGateways(t)
	ensureGatewayClass(t)
	ns := "mode-transition"
	ensureNamespace(t, ns)
	name := dpName("shifty")
	ctx := t.Context()
	r := newGatewayReconciler()

	// Start in LoadBalancer mode: a Service is created.
	createGateway(t, httpGateway("shifty", ns))
	mustReconcile(t, r, ns, "shifty")
	var svc corev1.Service
	if err := c.Get(ctx, types.NamespacedName{Namespace: ns, Name: name}, &svc); err != nil {
		t.Fatalf("expected Service in LB mode: %v", err)
	}

	// Switch to multi-network mode: add a network address and reconcile.
	gw := getGateway(t, ns, "shifty")
	netType := NetworkAddressType
	gw.Spec.Addresses = append(gw.Spec.Addresses, gatewayv1.GatewaySpecAddress{Type: &netType, Value: netFrontend})
	if err := c.Update(ctx, gw); err != nil {
		t.Fatalf("updating gateway to multi-network: %v", err)
	}
	mustReconcile(t, r, ns, "shifty")

	if err := c.Get(ctx, types.NamespacedName{Namespace: ns, Name: name}, &svc); !apierrors.IsNotFound(err) {
		t.Errorf("expected orphaned Service to be deleted, got err=%v", err)
	}
}

func TestRBACSubjectAggregationAcrossNamespaces(t *testing.T) {
	c := requireEnvtest(t)
	cleanupAllGateways(t)
	ensureGatewayClass(t)
	nsOne, nsTwo := "agg-ns-one", "agg-ns-two"
	ensureNamespace(t, nsOne)
	ensureNamespace(t, nsTwo)
	r := newGatewayReconciler()

	createGateway(t, httpGateway("gw1", nsOne))
	mustReconcile(t, r, nsOne, "gw1")
	createGateway(t, httpGateway("gw2", nsTwo))
	mustReconcile(t, r, nsTwo, "gw2")
	mustReconcileRBAC(t)

	subjects := crbSubjectNamespaces(t, c)
	if !subjects[nsOne] || !subjects[nsTwo] {
		t.Errorf("expected CRB subjects for both namespaces, got %v", subjects)
	}
	if len(subjects) != 2 {
		t.Errorf("expected exactly 2 subjects, got %d (%v)", len(subjects), subjects)
	}

	for _, ns := range []string{nsOne, nsTwo} {
		var sa corev1.ServiceAccount
		if err := c.Get(t.Context(), types.NamespacedName{Namespace: ns, Name: testSAName}, &sa); err != nil {
			t.Errorf("expected ServiceAccount in %s: %v", ns, err)
		}
	}
}

func TestRBACCleanupOnGatewayDeletion(t *testing.T) {
	c := requireEnvtest(t)
	cleanupAllGateways(t)
	ensureGatewayClass(t)
	nsKeep, nsGone := "del-ns-keep", "del-ns-gone"
	ensureNamespace(t, nsKeep)
	ensureNamespace(t, nsGone)
	r := newGatewayReconciler()
	ctx := t.Context()

	createGateway(t, httpGateway("keeper", nsKeep))
	mustReconcile(t, r, nsKeep, "keeper")
	createGateway(t, httpGateway("goner", nsGone))
	mustReconcile(t, r, nsGone, "goner")
	mustReconcileRBAC(t)

	if subjects := crbSubjectNamespaces(t, c); !subjects[nsKeep] || !subjects[nsGone] {
		t.Fatalf("precondition failed, CRB subjects=%v", subjects)
	}

	// Delete the goner Gateway and drive cleanup.
	deleteAndConverge(t, nsGone, "goner")

	subjects := crbSubjectNamespaces(t, c)
	if subjects[nsGone] {
		t.Errorf("expected %s subject removed from CRB, got %v", nsGone, subjects)
	}
	if !subjects[nsKeep] {
		t.Errorf("expected %s subject retained, got %v", nsKeep, subjects)
	}
	var sa corev1.ServiceAccount
	if err := c.Get(ctx, types.NamespacedName{Namespace: nsGone, Name: testSAName}, &sa); !apierrors.IsNotFound(err) {
		t.Errorf("expected ServiceAccount in %s deleted, got err=%v", nsGone, err)
	}

	// Delete the last Gateway: the shared CRB is removed entirely.
	deleteAndConverge(t, nsKeep, "keeper")
	var crb rbacv1.ClusterRoleBinding
	if err := c.Get(ctx, types.NamespacedName{Name: ClusterRoleBindingName}, &crb); !apierrors.IsNotFound(err) {
		t.Errorf("expected shared CRB deleted after last Gateway, got err=%v", err)
	}
}

func TestReconcileTargetPortStability(t *testing.T) {
	c := requireEnvtest(t)
	cleanupAllGateways(t)
	ensureGatewayClass(t)
	ns := "port-stability"
	ensureNamespace(t, ns)
	ctx := t.Context()
	r := newGatewayReconciler()
	name := dpName("stable")

	// Two privileged HTTP listeners (80, 90); HTTP avoids the HTTPS-needs-tls CEL rule.
	gw := &gatewayv1.Gateway{
		ObjectMeta: metav1.ObjectMeta{Name: "stable", Namespace: ns},
		Spec: gatewayv1.GatewaySpec{
			GatewayClassName: testGatewayClass,
			Listeners: []gatewayv1.Listener{
				{Name: "http-80", Port: 80, Protocol: gatewayv1.HTTPProtocolType},
				{Name: "http-90", Port: 90, Protocol: gatewayv1.HTTPProtocolType},
			},
		},
	}
	createGateway(t, gw)
	mustReconcile(t, r, ns, "stable")

	before := serviceTargetPorts(t, ns, name)
	if before[80] <= privilegedPortMax || before[90] <= privilegedPortMax || before[80] == before[90] {
		t.Fatalf("expected distinct unprivileged targets, got %v", before)
	}
	var depBefore appsv1.Deployment
	if err := c.Get(ctx, types.NamespacedName{Namespace: ns, Name: name}, &depBefore); err != nil {
		t.Fatalf("getting deployment: %v", err)
	}

	// Add a lower privileged listener (70): existing targets must not move, and the
	// Deployment pod template must not change (no per-listener ports → no restart).
	live := getGateway(t, ns, "stable")
	live.Spec.Listeners = append(live.Spec.Listeners,
		gatewayv1.Listener{Name: "http-70", Port: 70, Protocol: gatewayv1.HTTPProtocolType})
	if err := c.Update(ctx, live); err != nil {
		t.Fatalf("updating gateway: %v", err)
	}
	mustReconcile(t, r, ns, "stable")

	after := serviceTargetPorts(t, ns, name)
	if after[80] != before[80] || after[90] != before[90] {
		t.Errorf("existing targets moved: before %v after %v", before, after)
	}
	if after[70] <= privilegedPortMax || after[70] == before[80] || after[70] == before[90] {
		t.Errorf("expected a fresh distinct unprivileged target for 70, got %d (before=%v)", after[70], before)
	}

	var depAfter appsv1.Deployment
	if err := c.Get(ctx, types.NamespacedName{Namespace: ns, Name: name}, &depAfter); err != nil {
		t.Fatalf("getting deployment after: %v", err)
	}
	if depAfter.Generation != depBefore.Generation {
		t.Errorf("adding a listener churned the pod template: Deployment generation %d -> %d",
			depBefore.Generation, depAfter.Generation)
	}
}

func TestGatewayClassAcceptedAndFinalizer(t *testing.T) {
	requireEnvtest(t)
	cleanupAllGateways(t)
	ensureGatewayClass(t)
	ns := "gc-test"
	ensureNamespace(t, ns)
	ctx := t.Context()
	gcr := newGatewayClassReconciler()
	req := ctrl.Request{NamespacedName: types.NamespacedName{Name: testGatewayClass}}

	// A referencing Gateway makes the GatewayClass Accepted and adds the finalizer.
	createGateway(t, httpGateway("ref", ns))
	if _, err := gcr.Reconcile(ctx, req); err != nil {
		t.Fatalf("reconciling gatewayclass: %v", err)
	}
	var gc gatewayv1.GatewayClass
	if err := envClient.Get(ctx, types.NamespacedName{Name: testGatewayClass}, &gc); err != nil {
		t.Fatalf("getting gatewayclass: %v", err)
	}
	if got := conditionStatus(gc.Status.Conditions, string(gatewayv1.GatewayClassConditionStatusAccepted)); got != metav1.ConditionTrue {
		t.Errorf("expected GatewayClass Accepted=True, got %q", got)
	}
	if !controllerutil.ContainsFinalizer(&gc, gatewayClassFinalizer) {
		t.Errorf("expected gateway-exists finalizer on GatewayClass")
	}

	// Remove the Gateway: the finalizer is released.
	cleanupAllGateways(t)
	if _, err := gcr.Reconcile(ctx, req); err != nil {
		t.Fatalf("reconciling gatewayclass after gateway removal: %v", err)
	}
	if err := envClient.Get(ctx, types.NamespacedName{Name: testGatewayClass}, &gc); err != nil {
		t.Fatalf("getting gatewayclass: %v", err)
	}
	if controllerutil.ContainsFinalizer(&gc, gatewayClassFinalizer) {
		t.Errorf("expected gateway-exists finalizer removed when no Gateways reference the class")
	}
}
