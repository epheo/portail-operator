package controller

import (
	"crypto/sha256"
	"fmt"
	"strings"

	corev1 "k8s.io/api/core/v1"
	rbacv1 "k8s.io/api/rbac/v1"
	"k8s.io/apimachinery/pkg/util/intstr"
	"k8s.io/apimachinery/pkg/util/validation"
	appsv1ac "k8s.io/client-go/applyconfigurations/apps/v1"
	corev1ac "k8s.io/client-go/applyconfigurations/core/v1"
	metav1ac "k8s.io/client-go/applyconfigurations/meta/v1"
	policyv1ac "k8s.io/client-go/applyconfigurations/policy/v1"
	rbacv1ac "k8s.io/client-go/applyconfigurations/rbac/v1"
	gatewayv1 "sigs.k8s.io/gateway-api/apis/v1"
)

// NetworkAddressType is the custom address type used to identify multi-network Gateways.
const NetworkAddressType = gatewayv1.AddressType("portail.epheo.eu/Network")

// readinessDataPlanePort is the port portail serves its /readyz endpoint on,
// matching portail's --readiness-port default. Picked well clear of common
// Gateway listener ports (80/443/8080/8081/8443/...) so the readiness server
// doesn't collide with the data plane within the same pod.
const readinessDataPlanePort int32 = 19099

// ExtractNetworkNames returns deduplicated network names from Gateway addresses
// of type portail.epheo.eu/Network. It validates that each network name is a
// valid DNS-1123 subdomain, which is the format expected by Multus CNI.
func ExtractNetworkNames(gateway *gatewayv1.Gateway) ([]string, error) {
	seen := make(map[string]bool)
	var networks []string
	for _, addr := range gateway.Spec.Addresses {
		if addr.Type != nil && *addr.Type == NetworkAddressType {
			if errs := validation.IsDNS1123Subdomain(addr.Value); len(errs) > 0 {
				return nil, fmt.Errorf("invalid network name %q: %s", addr.Value, strings.Join(errs, "; "))
			}
			if !seen[addr.Value] {
				seen[addr.Value] = true
				networks = append(networks, addr.Value)
			}
		}
	}
	return networks, nil
}

// DerivedPort represents a port extracted from a Gateway listener.
type DerivedPort struct {
	Name     string
	Port     int32
	Protocol corev1.Protocol
}

// DerivePorts extracts unique ports from Gateway listeners.
// All protocols except UDP map to TCP at the transport layer.
func DerivePorts(gateway *gatewayv1.Gateway) []DerivedPort {
	seen := make(map[int32]bool)
	var ports []DerivedPort

	for _, listener := range gateway.Spec.Listeners {
		port := listener.Port
		if seen[port] {
			continue
		}
		seen[port] = true

		proto := corev1.ProtocolTCP
		if listener.Protocol == gatewayv1.UDPProtocolType {
			proto = corev1.ProtocolUDP
		}

		ports = append(ports, DerivedPort{
			Name:     fmt.Sprintf("%s-%d", strings.ToLower(string(proto)), port),
			Port:     port,
			Protocol: proto,
		})
	}

	return ports
}

func resourceName(gatewayName string) (string, error) {
	name := fmt.Sprintf("portail-%s", gatewayName)
	if errs := validation.IsDNS1123Label(name); len(errs) == 0 {
		return name, nil
	}

	// The prefixed name is invalid (almost always: too long — a DNS-1123 label is
	// capped at 63 chars and Gateway names can be much longer). Derive a stable,
	// unique, valid name by truncating and appending a short hash of the full
	// Gateway name: "portail-" (8) + trunc (<=46) + "-" (1) + hash (8) <= 63.
	const hashLen = 8
	const maxTrunc = 63 - len("portail-") - 1 - hashLen
	sum := sha256.Sum256([]byte(gatewayName))
	hash := fmt.Sprintf("%x", sum)[:hashLen]
	trunc := gatewayName
	if len(trunc) > maxTrunc {
		trunc = trunc[:maxTrunc]
	}
	trunc = strings.TrimRight(trunc, "-")
	name = fmt.Sprintf("portail-%s-%s", trunc, hash)
	if errs := validation.IsDNS1123Label(name); len(errs) > 0 {
		return "", fmt.Errorf("invalid resource name %q derived from gateway %q: %s", name, gatewayName, strings.Join(errs, "; "))
	}
	return name, nil
}

func commonLabels(gatewayName string) map[string]string {
	return map[string]string{
		"app.kubernetes.io/name":       "portail",
		"app.kubernetes.io/managed-by": "portail-operator",
		"portail.epheo.eu/gateway":     gatewayName,
	}
}

func ownerReference(gateway *gatewayv1.Gateway) *metav1ac.OwnerReferenceApplyConfiguration {
	return metav1ac.OwnerReference().
		WithAPIVersion(gatewayv1.GroupVersion.String()).
		WithKind("Gateway").
		WithName(gateway.Name).
		WithUID(gateway.UID).
		WithController(true).
		WithBlockOwnerDeletion(true)
}

// BuildDeployment creates the desired Deployment for a Gateway.
// When networks is non-empty, the pod template is annotated with k8s.v1.cni.cncf.io/networks
// for multi-network attachment.
func BuildDeployment(gateway *gatewayv1.Gateway, ports []DerivedPort, image, controllerName, serviceAccountName string, replicas int32, networks []string) (*appsv1ac.DeploymentApplyConfiguration, error) {
	name, err := resourceName(gateway.Name)
	if err != nil {
		return nil, err
	}
	labels := commonLabels(gateway.Name)
	selectorLabels := map[string]string{
		"portail.epheo.eu/gateway": gateway.Name,
	}

	containerPorts := make([]*corev1ac.ContainerPortApplyConfiguration, 0, len(ports))
	for _, p := range ports {
		containerPorts = append(containerPorts, corev1ac.ContainerPort().
			WithName(p.Name).
			WithContainerPort(p.Port).
			WithProtocol(p.Protocol))
	}

	container := corev1ac.Container().
		WithName("portail").
		WithImage(image).
		// IfNotPresent so locally-loaded images (kind/conformance, air-gapped)
		// are used instead of always re-pulling :latest.
		WithImagePullPolicy(corev1.PullIfNotPresent).
		WithArgs(
			"--kubernetes",
			"--controller-name", controllerName,
			// The operator owns Gateway/GatewayClass lifecycle status;
			// portail reports only listener + route status.
			"--manage-gateway-status=false",
			// Scope portail to this single Gateway — the operator
			// provisions one Deployment per Gateway, so each pod
			// only needs to reconcile its own.
			"--gateway", fmt.Sprintf("%s/%s", gateway.Namespace, gateway.Name),
		).
		WithPorts(containerPorts...).
		WithReadinessProbe(corev1ac.Probe().
			WithHTTPGet(corev1ac.HTTPGetAction().
				WithPath("/readyz").
				WithPort(intstr.FromInt32(readinessDataPlanePort))).
			WithInitialDelaySeconds(2).
			WithPeriodSeconds(5).
			WithFailureThreshold(6)).
		WithSecurityContext(corev1ac.SecurityContext().
			WithAllowPrivilegeEscalation(false).
			WithReadOnlyRootFilesystem(true).
			WithCapabilities(corev1ac.Capabilities().
				WithDrop(corev1.Capability("ALL")).
				WithAdd(corev1.Capability("NET_BIND_SERVICE"))))

	podSpec := corev1ac.PodSpec().
		WithServiceAccountName(serviceAccountName).
		WithSecurityContext(corev1ac.PodSecurityContext().
			WithRunAsNonRoot(true).
			WithSeccompProfile(corev1ac.SeccompProfile().
				WithType(corev1.SeccompProfileTypeRuntimeDefault))).
		WithContainers(container)

	podTemplate := corev1ac.PodTemplateSpec().
		WithLabels(labels).
		WithSpec(podSpec)
	if len(networks) > 0 {
		podTemplate = podTemplate.WithAnnotations(map[string]string{
			"k8s.v1.cni.cncf.io/networks": strings.Join(networks, ", "),
		})
	}

	return appsv1ac.Deployment(name, gateway.Namespace).
		WithLabels(labels).
		WithOwnerReferences(ownerReference(gateway)).
		WithSpec(appsv1ac.DeploymentSpec().
			WithReplicas(replicas).
			WithSelector(metav1ac.LabelSelector().WithMatchLabels(selectorLabels)).
			WithTemplate(podTemplate)), nil
}

// BuildServiceAccount creates the desired ServiceAccount for a Gateway's data plane.
// The ServiceAccount is shared across all Gateways in a namespace, so it has no
// OwnerReference to avoid garbage collection when any single Gateway is deleted.
// Cleanup is handled explicitly in cleanupRBAC.
func BuildServiceAccount(namespace, serviceAccountName string) *corev1ac.ServiceAccountApplyConfiguration {
	return corev1ac.ServiceAccount(serviceAccountName, namespace).
		WithLabels(map[string]string{
			"app.kubernetes.io/name":       "portail",
			"app.kubernetes.io/managed-by": "portail-operator",
		})
}

// ClusterRoleBindingName is the name of the shared ClusterRoleBinding for all data plane ServiceAccounts.
// This must match the kustomize-generated name (namePrefix + metadata.name from dataplane_binding.yaml).
const ClusterRoleBindingName = "portail-operator-dataplane-binding"

// BuildClusterRoleBinding creates a ClusterRoleBinding that binds the static data plane
// ClusterRole to ServiceAccounts across multiple namespaces.
func BuildClusterRoleBinding(clusterRoleName string, subjects []rbacv1.Subject) *rbacv1ac.ClusterRoleBindingApplyConfiguration {
	subjectACs := make([]*rbacv1ac.SubjectApplyConfiguration, 0, len(subjects))
	for _, s := range subjects {
		sa := rbacv1ac.Subject().WithKind(s.Kind).WithName(s.Name)
		if s.Namespace != "" {
			sa = sa.WithNamespace(s.Namespace)
		}
		subjectACs = append(subjectACs, sa)
	}
	return rbacv1ac.ClusterRoleBinding(ClusterRoleBindingName).
		WithLabels(map[string]string{
			"app.kubernetes.io/name":       "portail",
			"app.kubernetes.io/managed-by": "portail-operator",
		}).
		WithRoleRef(rbacv1ac.RoleRef().
			WithAPIGroup("rbac.authorization.k8s.io").
			WithKind("ClusterRole").
			WithName(clusterRoleName)).
		WithSubjects(subjectACs...)
}

// BuildPodDisruptionBudget creates the desired PDB for a Gateway's data plane.
// It ensures at least one pod remains available during voluntary disruptions.
func BuildPodDisruptionBudget(gateway *gatewayv1.Gateway) (*policyv1ac.PodDisruptionBudgetApplyConfiguration, error) {
	name, err := resourceName(gateway.Name)
	if err != nil {
		return nil, err
	}
	selectorLabels := map[string]string{
		"portail.epheo.eu/gateway": gateway.Name,
	}

	return policyv1ac.PodDisruptionBudget(name, gateway.Namespace).
		WithLabels(commonLabels(gateway.Name)).
		WithOwnerReferences(ownerReference(gateway)).
		WithSpec(policyv1ac.PodDisruptionBudgetSpec().
			WithMaxUnavailable(intstr.FromInt32(1)).
			WithSelector(metav1ac.LabelSelector().WithMatchLabels(selectorLabels))), nil
}

// BuildService creates the desired LoadBalancer Service for a Gateway.
func BuildService(gateway *gatewayv1.Gateway, ports []DerivedPort) (*corev1ac.ServiceApplyConfiguration, error) {
	name, err := resourceName(gateway.Name)
	if err != nil {
		return nil, err
	}
	labels := commonLabels(gateway.Name)
	selectorLabels := map[string]string{
		"portail.epheo.eu/gateway": gateway.Name,
	}

	servicePorts := make([]*corev1ac.ServicePortApplyConfiguration, 0, len(ports))
	for _, p := range ports {
		servicePorts = append(servicePorts, corev1ac.ServicePort().
			WithName(p.Name).
			WithPort(p.Port).
			WithTargetPort(intstr.FromInt32(p.Port)).
			WithProtocol(p.Protocol))
	}

	spec := corev1ac.ServiceSpec().
		WithType(corev1.ServiceTypeLoadBalancer).
		WithSelector(selectorLabels).
		WithPorts(servicePorts...)

	svc := corev1ac.Service(name, gateway.Namespace).
		WithLabels(labels).
		WithOwnerReferences(ownerReference(gateway))

	// Honor Gateway spec.addresses (IPAddress) by requesting that VIP from the
	// LoadBalancer provider. Sets the standard (deprecated but widely honored)
	// field plus the MetalLB annotation (MetalLB >= 0.13). This makes the
	// GatewayStaticAddresses behavior work: the requested address is what the
	// Service is assigned.
	if ips := staticIPAddresses(gateway); len(ips) > 0 {
		spec = spec.WithLoadBalancerIP(ips[0])
		svc = svc.WithAnnotations(map[string]string{
			"metallb.universe.tf/loadBalancerIPs": strings.Join(ips, ","),
		})
	}

	return svc.WithSpec(spec), nil
}

// staticIPAddresses returns the IPAddress-typed values from spec.addresses
// (the default type when unset), used to request a specific LoadBalancer VIP.
func staticIPAddresses(gateway *gatewayv1.Gateway) []string {
	var ips []string
	for _, addr := range gateway.Spec.Addresses {
		if addr.Type == nil || *addr.Type == gatewayv1.IPAddressType {
			if addr.Value != "" {
				ips = append(ips, addr.Value)
			}
		}
	}
	return ips
}
