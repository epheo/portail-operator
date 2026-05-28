package controller

import (
	"crypto/sha256"
	"fmt"
	"strings"

	appsv1 "k8s.io/api/apps/v1"
	corev1 "k8s.io/api/core/v1"
	policyv1 "k8s.io/api/policy/v1"
	rbacv1 "k8s.io/api/rbac/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/util/intstr"
	"k8s.io/apimachinery/pkg/util/validation"
	"k8s.io/utils/ptr"
	gatewayv1 "sigs.k8s.io/gateway-api/apis/v1"
)

// NetworkAddressType is the custom address type used to identify multi-network Gateways.
const NetworkAddressType = gatewayv1.AddressType("portail.epheo.eu/Network")

// readinessDataPlanePort is the port portail serves its /readyz endpoint on,
// matching portail's --readiness-port default.
const readinessDataPlanePort int32 = 8081

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
		port := int32(listener.Port)
		if seen[port] {
			continue
		}
		seen[port] = true

		proto := corev1.ProtocolTCP
		if listener.Protocol == gatewayv1.UDPProtocolType {
			proto = corev1.ProtocolUDP
		}

		ports = append(ports, DerivedPort{
			Name:     string(listener.Name),
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

func ownerReference(gateway *gatewayv1.Gateway) metav1.OwnerReference {
	return metav1.OwnerReference{
		APIVersion:         gatewayv1.GroupVersion.String(),
		Kind:               "Gateway",
		Name:               gateway.Name,
		UID:                gateway.UID,
		Controller:         ptr.To(true),
		BlockOwnerDeletion: ptr.To(true),
	}
}

// BuildDeployment creates the desired Deployment for a Gateway.
// When networks is non-empty, the pod template is annotated with k8s.v1.cni.cncf.io/networks
// for multi-network attachment.
func BuildDeployment(gateway *gatewayv1.Gateway, ports []DerivedPort, image, controllerName, serviceAccountName string, replicas int32, networks []string) (*appsv1.Deployment, error) {
	name, err := resourceName(gateway.Name)
	if err != nil {
		return nil, err
	}
	labels := commonLabels(gateway.Name)
	selectorLabels := map[string]string{
		"portail.epheo.eu/gateway": gateway.Name,
	}

	var containerPorts []corev1.ContainerPort
	for _, p := range ports {
		containerPorts = append(containerPorts, corev1.ContainerPort{
			Name:          p.Name,
			ContainerPort: p.Port,
			Protocol:      p.Protocol,
		})
	}

	var podAnnotations map[string]string
	if len(networks) > 0 {
		podAnnotations = map[string]string{
			"k8s.v1.cni.cncf.io/networks": strings.Join(networks, ", "),
		}
	}

	return &appsv1.Deployment{
		TypeMeta: metav1.TypeMeta{
			APIVersion: "apps/v1",
			Kind:       "Deployment",
		},
		ObjectMeta: metav1.ObjectMeta{
			Name:            name,
			Namespace:       gateway.Namespace,
			Labels:          labels,
			OwnerReferences: []metav1.OwnerReference{ownerReference(gateway)},
		},
		Spec: appsv1.DeploymentSpec{
			Replicas: ptr.To(replicas),
			Selector: &metav1.LabelSelector{
				MatchLabels: selectorLabels,
			},
			Template: corev1.PodTemplateSpec{
				ObjectMeta: metav1.ObjectMeta{
					Labels:      labels,
					Annotations: podAnnotations,
				},
				Spec: corev1.PodSpec{
					ServiceAccountName: serviceAccountName,
					SecurityContext: &corev1.PodSecurityContext{
						RunAsNonRoot: ptr.To(true),
						SeccompProfile: &corev1.SeccompProfile{
							Type: corev1.SeccompProfileTypeRuntimeDefault,
						},
					},
					Containers: []corev1.Container{
						{
							Name:  "portail",
							Image: image,
							// IfNotPresent so locally-loaded images (kind/conformance,
							// air-gapped) are used instead of always re-pulling :latest.
							ImagePullPolicy: corev1.PullIfNotPresent,
							Args: []string{
								"--kubernetes",
								"--controller-name", controllerName,
								// The operator owns Gateway/GatewayClass lifecycle status;
								// portail reports only listener + route status.
								"--manage-gateway-status=false",
							},
							Ports: containerPorts,
							ReadinessProbe: &corev1.Probe{
								ProbeHandler: corev1.ProbeHandler{
									HTTPGet: &corev1.HTTPGetAction{
										Path: "/readyz",
										Port: intstr.FromInt32(readinessDataPlanePort),
									},
								},
								InitialDelaySeconds: 2,
								PeriodSeconds:       5,
								FailureThreshold:    6,
							},
							SecurityContext: &corev1.SecurityContext{
								AllowPrivilegeEscalation: ptr.To(false),
								ReadOnlyRootFilesystem:   ptr.To(true),
								Capabilities: &corev1.Capabilities{
									Drop: []corev1.Capability{"ALL"},
									Add:  []corev1.Capability{"NET_BIND_SERVICE"},
								},
							},
						},
					},
				},
			},
		},
	}, nil
}

// BuildServiceAccount creates the desired ServiceAccount for a Gateway's data plane.
// The ServiceAccount is shared across all Gateways in a namespace, so it has no
// OwnerReference to avoid garbage collection when any single Gateway is deleted.
// Cleanup is handled explicitly in cleanupRBAC.
func BuildServiceAccount(namespace, serviceAccountName string) *corev1.ServiceAccount {
	return &corev1.ServiceAccount{
		TypeMeta: metav1.TypeMeta{
			APIVersion: "v1",
			Kind:       "ServiceAccount",
		},
		ObjectMeta: metav1.ObjectMeta{
			Name:      serviceAccountName,
			Namespace: namespace,
			Labels: map[string]string{
				"app.kubernetes.io/name":       "portail",
				"app.kubernetes.io/managed-by": "portail-operator",
			},
		},
	}
}

// ClusterRoleBindingName is the name of the shared ClusterRoleBinding for all data plane ServiceAccounts.
// This must match the kustomize-generated name (namePrefix + metadata.name from dataplane_binding.yaml).
const ClusterRoleBindingName = "portail-operator-dataplane-binding"

// BuildClusterRoleBinding creates a ClusterRoleBinding that binds the static data plane
// ClusterRole to ServiceAccounts across multiple namespaces.
func BuildClusterRoleBinding(clusterRoleName string, subjects []rbacv1.Subject) *rbacv1.ClusterRoleBinding {
	return &rbacv1.ClusterRoleBinding{
		TypeMeta: metav1.TypeMeta{
			APIVersion: "rbac.authorization.k8s.io/v1",
			Kind:       "ClusterRoleBinding",
		},
		ObjectMeta: metav1.ObjectMeta{
			Name: ClusterRoleBindingName,
			Labels: map[string]string{
				"app.kubernetes.io/name":       "portail",
				"app.kubernetes.io/managed-by": "portail-operator",
			},
		},
		RoleRef: rbacv1.RoleRef{
			APIGroup: "rbac.authorization.k8s.io",
			Kind:     "ClusterRole",
			Name:     clusterRoleName,
		},
		Subjects: subjects,
	}
}

// BuildPodDisruptionBudget creates the desired PDB for a Gateway's data plane.
// It ensures at least one pod remains available during voluntary disruptions.
func BuildPodDisruptionBudget(gateway *gatewayv1.Gateway) (*policyv1.PodDisruptionBudget, error) {
	name, err := resourceName(gateway.Name)
	if err != nil {
		return nil, err
	}
	labels := commonLabels(gateway.Name)
	selectorLabels := map[string]string{
		"portail.epheo.eu/gateway": gateway.Name,
	}

	maxUnavailable := intstr.FromInt32(1)

	return &policyv1.PodDisruptionBudget{
		TypeMeta: metav1.TypeMeta{
			APIVersion: "policy/v1",
			Kind:       "PodDisruptionBudget",
		},
		ObjectMeta: metav1.ObjectMeta{
			Name:            name,
			Namespace:       gateway.Namespace,
			Labels:          labels,
			OwnerReferences: []metav1.OwnerReference{ownerReference(gateway)},
		},
		Spec: policyv1.PodDisruptionBudgetSpec{
			MaxUnavailable: &maxUnavailable,
			Selector: &metav1.LabelSelector{
				MatchLabels: selectorLabels,
			},
		},
	}, nil
}

// BuildService creates the desired LoadBalancer Service for a Gateway.
func BuildService(gateway *gatewayv1.Gateway, ports []DerivedPort) (*corev1.Service, error) {
	name, err := resourceName(gateway.Name)
	if err != nil {
		return nil, err
	}
	labels := commonLabels(gateway.Name)
	selectorLabels := map[string]string{
		"portail.epheo.eu/gateway": gateway.Name,
	}

	var servicePorts []corev1.ServicePort
	for _, p := range ports {
		servicePorts = append(servicePorts, corev1.ServicePort{
			Name:       p.Name,
			Port:       p.Port,
			TargetPort: intstr.FromInt32(p.Port),
			Protocol:   p.Protocol,
		})
	}

	svc := &corev1.Service{
		TypeMeta: metav1.TypeMeta{
			APIVersion: "v1",
			Kind:       "Service",
		},
		ObjectMeta: metav1.ObjectMeta{
			Name:            name,
			Namespace:       gateway.Namespace,
			Labels:          labels,
			OwnerReferences: []metav1.OwnerReference{ownerReference(gateway)},
		},
		Spec: corev1.ServiceSpec{
			Type:     corev1.ServiceTypeLoadBalancer,
			Selector: selectorLabels,
			Ports:    servicePorts,
		},
	}

	// Honor Gateway spec.addresses (IPAddress) by requesting that VIP from the
	// LoadBalancer provider. Sets the standard (deprecated but widely honored)
	// field plus the MetalLB annotation (MetalLB >= 0.13). This makes the
	// GatewayStaticAddresses behavior work: the requested address is what the
	// Service is assigned.
	if ips := staticIPAddresses(gateway); len(ips) > 0 {
		svc.Spec.LoadBalancerIP = ips[0]
		svc.ObjectMeta.Annotations = map[string]string{
			"metallb.universe.tf/loadBalancerIPs": strings.Join(ips, ","),
		}
	}

	return svc, nil
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
