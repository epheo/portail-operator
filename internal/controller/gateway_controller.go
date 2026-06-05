package controller

import (
	"context"
	"fmt"

	appsv1 "k8s.io/api/apps/v1"
	corev1 "k8s.io/api/core/v1"
	policyv1 "k8s.io/api/policy/v1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	apimeta "k8s.io/apimachinery/pkg/api/meta"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/types"
	appsv1ac "k8s.io/client-go/applyconfigurations/apps/v1"
	"k8s.io/client-go/tools/events"
	ctrl "sigs.k8s.io/controller-runtime"
	"sigs.k8s.io/controller-runtime/pkg/client"
	"sigs.k8s.io/controller-runtime/pkg/handler"
	"sigs.k8s.io/controller-runtime/pkg/log"
	"sigs.k8s.io/controller-runtime/pkg/reconcile"
	gatewayv1 "sigs.k8s.io/gateway-api/apis/v1"
)

// GatewayReconciler reconciles Gateway objects by managing Deployment and Service resources.
// Cluster-wide data-plane RBAC is owned separately by DataPlaneRBACReconciler.
type GatewayReconciler struct {
	client.Client
	Scheme             *runtime.Scheme
	Recorder           events.EventRecorder
	ControllerName     string
	Image              string
	Replicas           int32
	ServiceAccountName string
}

// +kubebuilder:rbac:groups=gateway.networking.k8s.io,resources=gateways,verbs=get;list;watch
// +kubebuilder:rbac:groups=gateway.networking.k8s.io,resources=gateways/status,verbs=get;update;patch
// +kubebuilder:rbac:groups=gateway.networking.k8s.io,resources=gateways/finalizers,verbs=update
// +kubebuilder:rbac:groups=apps,resources=deployments,verbs=get;list;watch;create;update;patch;delete
// +kubebuilder:rbac:groups="",resources=services,verbs=get;list;watch;create;update;patch;delete
// +kubebuilder:rbac:groups="",resources=serviceaccounts,verbs=get;list;watch;create;update;patch
// +kubebuilder:rbac:groups="",resources=events,verbs=create;patch
// +kubebuilder:rbac:groups=events.k8s.io,resources=events,verbs=create;patch
// +kubebuilder:rbac:groups=policy,resources=poddisruptionbudgets,verbs=get;list;watch;create;update;patch;delete

func (r *GatewayReconciler) Reconcile(ctx context.Context, req ctrl.Request) (ctrl.Result, error) {
	logger := log.FromContext(ctx)

	// Fetch the Gateway
	var gateway gatewayv1.Gateway
	if err := r.Get(ctx, req.NamespacedName, &gateway); err != nil {
		if apierrors.IsNotFound(err) {
			return ctrl.Result{}, nil
		}
		return ctrl.Result{}, err
	}

	// Verify the GatewayClass is ours
	managed, err := r.isManaged(ctx, &gateway)
	if err != nil {
		return ctrl.Result{}, err
	}
	if !managed {
		return ctrl.Result{}, nil
	}

	// A Gateway being deleted needs no provisioning: its Deployment/Service/PDB are
	// reclaimed by owner-reference garbage collection, and DataPlaneRBACReconciler
	// prunes the shared RBAC when it observes the deletion. No finalizer required.
	if !gateway.DeletionTimestamp.IsZero() {
		return ctrl.Result{}, nil
	}

	logger.Info("Reconciling Gateway", "gateway", gateway.Name, "namespace", gateway.Namespace)

	// Derive ports and detect mode
	ports := DerivePorts(&gateway)
	networks, err := ExtractNetworkNames(&gateway)
	if err != nil {
		return r.failAccepted(ctx, &gateway, "InvalidNetwork", fmt.Sprintf("Invalid network name: %v", err), err.Error())
	}

	// Ensure the data plane ServiceAccount exists. Its cluster-wide RBAC (the shared
	// ClusterRoleBinding) and orphan cleanup are owned by DataPlaneRBACReconciler.
	desiredSA := BuildServiceAccount(gateway.Namespace, r.ServiceAccountName)
	if err := r.Apply(ctx, desiredSA, client.FieldOwner("portail-operator"), client.ForceOwnership); err != nil {
		r.Recorder.Eventf(&gateway, nil, corev1.EventTypeWarning, "ServiceAccountFailed", "ServiceAccountFailed", "Failed to apply ServiceAccount: %v", err)
		return ctrl.Result{}, fmt.Errorf("applying ServiceAccount: %w", err)
	}

	desiredDeploy, err := BuildDeployment(&gateway, r.Image, r.ControllerName, r.ServiceAccountName, r.Replicas, networks)
	if err != nil {
		return r.failAccepted(ctx, &gateway, "InvalidGateway", fmt.Sprintf("Invalid gateway name: %v", err), err.Error())
	}

	// Apply Deployment via Server-Side Apply (both modes)
	if err := r.Apply(ctx, desiredDeploy, client.FieldOwner("portail-operator"), client.ForceOwnership); err != nil {
		r.Recorder.Eventf(&gateway, nil, corev1.EventTypeWarning, "DeploymentFailed", "DeploymentFailed", "Failed to apply Deployment: %v", err)
		return ctrl.Result{}, fmt.Errorf("applying Deployment: %w", err)
	}
	r.Recorder.Eventf(&gateway, nil, corev1.EventTypeNormal, "DeploymentApplied", "DeploymentApplied", "Deployment %q applied", *desiredDeploy.Name)
	logger.Info("Applied Deployment", "name", *desiredDeploy.Name)

	// Apply PodDisruptionBudget
	desiredPDB, err := BuildPodDisruptionBudget(&gateway)
	if err != nil {
		return ctrl.Result{}, fmt.Errorf("building PodDisruptionBudget: %w", err)
	}
	if err := r.Apply(ctx, desiredPDB, client.FieldOwner("portail-operator"), client.ForceOwnership); err != nil {
		r.Recorder.Eventf(&gateway, nil, corev1.EventTypeWarning, "PDBFailed", "PDBFailed", "Failed to apply PodDisruptionBudget: %v", err)
		return ctrl.Result{}, fmt.Errorf("applying PodDisruptionBudget: %w", err)
	}
	logger.Info("Applied PodDisruptionBudget", "name", *desiredPDB.Name)

	if len(networks) > 0 {
		// Multi-network mode: no Service needed
		r.Recorder.Eventf(&gateway, nil, corev1.EventTypeNormal, "MultiNetworkMode", "MultiNetworkMode", "Multi-network mode with networks: %v", networks)
		if err := r.deleteOrphanedService(ctx, &gateway); err != nil {
			return ctrl.Result{}, fmt.Errorf("cleaning up orphaned Service: %w", err)
		}
		if err := r.patchStatus(ctx, &gateway, desiredDeploy, networkAddresses(networks)); err != nil {
			return ctrl.Result{}, fmt.Errorf("updating Gateway status: %w", err)
		}
	} else {
		// LoadBalancer mode. Allocate unprivileged target ports, preserving the live
		// Service's existing assignments so unchanged listeners keep their bind port.
		targets := allocateTargetPorts(ports, r.existingTargetPorts(ctx, &gateway))
		desiredService, err := BuildService(&gateway, ports, targets)
		if err != nil {
			return ctrl.Result{}, fmt.Errorf("building Service: %w", err)
		}
		if err := r.Apply(ctx, desiredService, client.FieldOwner("portail-operator"), client.ForceOwnership); err != nil {
			r.Recorder.Eventf(&gateway, nil, corev1.EventTypeWarning, "ServiceFailed", "ServiceFailed", "Failed to apply Service: %v", err)
			return ctrl.Result{}, fmt.Errorf("applying Service: %w", err)
		}
		r.Recorder.Eventf(&gateway, nil, corev1.EventTypeNormal, "ServiceApplied", "ServiceApplied", "Service %q applied (LoadBalancer)", *desiredService.Name)
		logger.Info("Applied Service", "name", *desiredService.Name)

		addresses := r.loadBalancerAddresses(ctx, &gateway, *desiredService.Name, *desiredService.Namespace)
		if err := r.patchStatus(ctx, &gateway, desiredDeploy, addresses); err != nil {
			return ctrl.Result{}, fmt.Errorf("updating Gateway status: %w", err)
		}
	}

	return ctrl.Result{}, nil
}

// existingTargetPorts returns the published->target port mapping from the Gateway's
// current Service, if one exists. It lets the operator preserve target assignments
// across reconciles so an unchanged listener keeps its (unprivileged) bind port.
func (r *GatewayReconciler) existingTargetPorts(ctx context.Context, gateway *gatewayv1.Gateway) map[int32]int32 {
	out := map[int32]int32{}
	name, err := resourceName(gateway.Name)
	if err != nil {
		return out
	}
	var svc corev1.Service
	if err := r.Get(ctx, types.NamespacedName{Name: name, Namespace: gateway.Namespace}, &svc); err != nil {
		return out
	}
	for _, p := range svc.Spec.Ports {
		if tp := int32(p.TargetPort.IntValue()); tp != 0 {
			out[p.Port] = tp
		}
	}
	return out
}

// isManaged reports whether the Gateway's GatewayClass is implemented by this
// operator. A missing GatewayClass is treated as not-ours (no error).
func (r *GatewayReconciler) isManaged(ctx context.Context, gw *gatewayv1.Gateway) (bool, error) {
	var gc gatewayv1.GatewayClass
	if err := r.Get(ctx, types.NamespacedName{Name: string(gw.Spec.GatewayClassName)}, &gc); err != nil {
		if apierrors.IsNotFound(err) {
			log.FromContext(ctx).V(1).Info("GatewayClass not found, skipping", "gatewayClass", gw.Spec.GatewayClassName)
			return false, nil
		}
		return false, err
	}
	return gc.Spec.ControllerName == gatewayv1.GatewayController(r.ControllerName), nil
}

// failAccepted records a warning event, marks the Gateway Accepted=False with the
// InvalidParameters reason, and stops reconciliation without requeue: the spec must
// change before progress is possible, so retrying as-is would only churn.
func (r *GatewayReconciler) failAccepted(ctx context.Context, gateway *gatewayv1.Gateway, eventReason, eventMessage, condMessage string) (ctrl.Result, error) {
	r.Recorder.Eventf(gateway, nil, corev1.EventTypeWarning, eventReason, eventReason, "%s", eventMessage)
	apimeta.SetStatusCondition(&gateway.Status.Conditions, metav1.Condition{
		Type:               string(gatewayv1.GatewayConditionAccepted),
		Status:             metav1.ConditionFalse,
		ObservedGeneration: gateway.Generation,
		LastTransitionTime: metav1.Now(),
		Reason:             string(gatewayv1.GatewayReasonInvalidParameters),
		Message:            condMessage,
	})
	if err := r.Status().Update(ctx, gateway); err != nil {
		log.FromContext(ctx).Error(err, "Failed to update Gateway status")
	}
	return ctrl.Result{}, nil
}

// patchStatus sets the Accepted and Programmed conditions, assigns the supplied
// status addresses, and patches the Gateway status. Address derivation differs by
// mode (LoadBalancer ingress vs. attached network names) and is done by the caller.
func (r *GatewayReconciler) patchStatus(ctx context.Context, gateway *gatewayv1.Gateway, deploy *appsv1ac.DeploymentApplyConfiguration, addresses []gatewayv1.GatewayStatusAddress) error {
	patch := client.MergeFrom(gateway.DeepCopy())

	apimeta.SetStatusCondition(&gateway.Status.Conditions, metav1.Condition{
		Type:               string(gatewayv1.GatewayConditionAccepted),
		Status:             metav1.ConditionTrue,
		ObservedGeneration: gateway.Generation,
		LastTransitionTime: metav1.Now(),
		Reason:             string(gatewayv1.GatewayReasonAccepted),
		Message:            "Gateway accepted by portail-operator",
	})
	apimeta.SetStatusCondition(&gateway.Status.Conditions, r.programmedCondition(ctx, gateway, deploy))

	gateway.Status.Addresses = addresses
	return r.Status().Patch(ctx, gateway, patch)
}

// loadBalancerAddresses maps a Service's LoadBalancer ingress to Gateway status
// addresses. If the Service can't be read it returns the Gateway's current
// addresses unchanged, so a transient read error doesn't clear published VIPs.
func (r *GatewayReconciler) loadBalancerAddresses(ctx context.Context, gateway *gatewayv1.Gateway, name, namespace string) []gatewayv1.GatewayStatusAddress {
	var svc corev1.Service
	if err := r.Get(ctx, types.NamespacedName{Name: name, Namespace: namespace}, &svc); err != nil {
		return gateway.Status.Addresses
	}
	var addresses []gatewayv1.GatewayStatusAddress
	for _, ingress := range svc.Status.LoadBalancer.Ingress {
		if ingress.IP != "" {
			addrType := gatewayv1.IPAddressType
			addresses = append(addresses, gatewayv1.GatewayStatusAddress{Type: &addrType, Value: ingress.IP})
		}
		if ingress.Hostname != "" {
			addrType := gatewayv1.HostnameAddressType
			addresses = append(addresses, gatewayv1.GatewayStatusAddress{Type: &addrType, Value: ingress.Hostname})
		}
	}
	return addresses
}

func (r *GatewayReconciler) programmedCondition(ctx context.Context, gateway *gatewayv1.Gateway, deploy *appsv1ac.DeploymentApplyConfiguration) metav1.Condition {
	now := metav1.Now()

	var currentDeploy appsv1.Deployment
	if err := r.Get(ctx, types.NamespacedName{Name: *deploy.Name, Namespace: *deploy.Namespace}, &currentDeploy); err != nil {
		return metav1.Condition{
			Type:               string(gatewayv1.GatewayConditionProgrammed),
			Status:             metav1.ConditionFalse,
			ObservedGeneration: gateway.Generation,
			LastTransitionTime: now,
			Reason:             string(gatewayv1.GatewayReasonPending),
			Message:            "Waiting for Deployment to be created",
		}
	}

	if currentDeploy.Status.AvailableReplicas > 0 {
		r.Recorder.Eventf(gateway, nil, corev1.EventTypeNormal, "DataPlaneReady", "DataPlaneReady",
			"Data plane ready: %d/%d replicas available",
			currentDeploy.Status.AvailableReplicas, currentDeploy.Status.Replicas)
		return metav1.Condition{
			Type:               string(gatewayv1.GatewayConditionProgrammed),
			Status:             metav1.ConditionTrue,
			ObservedGeneration: gateway.Generation,
			LastTransitionTime: now,
			Reason:             string(gatewayv1.GatewayReasonProgrammed),
			Message: fmt.Sprintf("Data plane ready: %d/%d replicas available",
				currentDeploy.Status.AvailableReplicas, currentDeploy.Status.Replicas),
		}
	}

	r.Recorder.Eventf(gateway, nil, corev1.EventTypeNormal, "DataPlanePending", "DataPlanePending",
		"Waiting for data plane: 0/%d replicas available",
		currentDeploy.Status.Replicas)
	return metav1.Condition{
		Type:               string(gatewayv1.GatewayConditionProgrammed),
		Status:             metav1.ConditionFalse,
		ObservedGeneration: gateway.Generation,
		LastTransitionTime: now,
		Reason:             string(gatewayv1.GatewayReasonPending),
		Message: fmt.Sprintf("Waiting for data plane: 0/%d replicas available",
			currentDeploy.Status.Replicas),
	}
}

func (r *GatewayReconciler) deleteOrphanedService(ctx context.Context, gateway *gatewayv1.Gateway) error {
	name, err := resourceName(gateway.Name)
	if err != nil {
		return err
	}
	var svc corev1.Service
	err = r.Get(ctx, types.NamespacedName{Name: name, Namespace: gateway.Namespace}, &svc)
	if apierrors.IsNotFound(err) {
		return nil
	}
	if err != nil {
		return err
	}
	return r.Delete(ctx, &svc)
}

// networkAddresses builds Gateway status addresses from multi-network names.
func networkAddresses(networks []string) []gatewayv1.GatewayStatusAddress {
	addresses := make([]gatewayv1.GatewayStatusAddress, 0, len(networks))
	for _, net := range networks {
		addrType := NetworkAddressType
		addresses = append(addresses, gatewayv1.GatewayStatusAddress{Type: &addrType, Value: net})
	}
	return addresses
}

func (r *GatewayReconciler) gatewayClassToGateways(ctx context.Context, obj client.Object) []reconcile.Request {
	gc, ok := obj.(*gatewayv1.GatewayClass)
	if !ok {
		return nil
	}

	var gatewayList gatewayv1.GatewayList
	if err := r.List(ctx, &gatewayList); err != nil {
		return nil
	}

	var requests []reconcile.Request
	for i := range gatewayList.Items {
		if string(gatewayList.Items[i].Spec.GatewayClassName) == gc.Name {
			requests = append(requests, reconcile.Request{
				NamespacedName: types.NamespacedName{
					Name:      gatewayList.Items[i].Name,
					Namespace: gatewayList.Items[i].Namespace,
				},
			})
		}
	}
	return requests
}

func (r *GatewayReconciler) SetupWithManager(mgr ctrl.Manager) error {
	return ctrl.NewControllerManagedBy(mgr).
		For(&gatewayv1.Gateway{}).
		Owns(&appsv1.Deployment{}).
		Owns(&corev1.Service{}).
		Owns(&policyv1.PodDisruptionBudget{}).
		Watches(&gatewayv1.GatewayClass{}, handler.EnqueueRequestsFromMapFunc(r.gatewayClassToGateways)).
		Complete(r)
}
