package controller

import (
	"context"
	"fmt"

	appsv1 "k8s.io/api/apps/v1"
	corev1 "k8s.io/api/core/v1"
	policyv1 "k8s.io/api/policy/v1"
	rbacv1 "k8s.io/api/rbac/v1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	apimeta "k8s.io/apimachinery/pkg/api/meta"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/types"
	"k8s.io/client-go/tools/record"
	ctrl "sigs.k8s.io/controller-runtime"
	"sigs.k8s.io/controller-runtime/pkg/client"
	"sigs.k8s.io/controller-runtime/pkg/controller/controllerutil"
	"sigs.k8s.io/controller-runtime/pkg/handler"
	"sigs.k8s.io/controller-runtime/pkg/log"
	"sigs.k8s.io/controller-runtime/pkg/reconcile"
	gatewayv1 "sigs.k8s.io/gateway-api/apis/v1"
)

const gatewayFinalizer = "portail.epheo.eu/rbac-cleanup"

// GatewayReconciler reconciles Gateway objects by managing Deployment and Service resources.
type GatewayReconciler struct {
	client.Client
	Scheme             *runtime.Scheme
	Recorder           record.EventRecorder
	ControllerName     string
	Image              string
	Replicas           int32
	ServiceAccountName string
	DataplaneRoleName  string
}

// +kubebuilder:rbac:groups=gateway.networking.k8s.io,resources=gateways,verbs=get;list;watch;update
// +kubebuilder:rbac:groups=gateway.networking.k8s.io,resources=gateways/finalizers,verbs=update
// +kubebuilder:rbac:groups=gateway.networking.k8s.io,resources=gateways/status,verbs=get;update;patch
// +kubebuilder:rbac:groups=apps,resources=deployments,verbs=get;list;watch;create;update;patch;delete
// +kubebuilder:rbac:groups="",resources=services,verbs=get;list;watch;create;update;patch;delete
// +kubebuilder:rbac:groups="",resources=serviceaccounts,verbs=get;list;watch;create;update;patch;delete
// +kubebuilder:rbac:groups="",resources=events,verbs=create;patch
// +kubebuilder:rbac:groups=policy,resources=poddisruptionbudgets,verbs=get;list;watch;create;update;patch;delete
// +kubebuilder:rbac:groups=rbac.authorization.k8s.io,resources=clusterrolebindings,verbs=get;list;watch;create;update;patch;delete

func (r *GatewayReconciler) Reconcile(ctx context.Context, req ctrl.Request) (ctrl.Result, error) {
	log := log.FromContext(ctx)

	// Fetch the Gateway
	var gateway gatewayv1.Gateway
	if err := r.Get(ctx, req.NamespacedName, &gateway); err != nil {
		if apierrors.IsNotFound(err) {
			return ctrl.Result{}, nil
		}
		return ctrl.Result{}, err
	}

	// Verify the GatewayClass is ours
	var gc gatewayv1.GatewayClass
	if err := r.Get(ctx, types.NamespacedName{Name: string(gateway.Spec.GatewayClassName)}, &gc); err != nil {
		if apierrors.IsNotFound(err) {
			log.V(1).Info("GatewayClass not found, skipping", "gatewayClass", gateway.Spec.GatewayClassName)
			return ctrl.Result{}, nil
		}
		return ctrl.Result{}, err
	}
	if gc.Spec.ControllerName != gatewayv1.GatewayController(r.ControllerName) {
		return ctrl.Result{}, nil
	}

	// Handle deletion: clean up cluster-scoped and namespace-scoped RBAC
	if !gateway.DeletionTimestamp.IsZero() {
		if controllerutil.ContainsFinalizer(&gateway, gatewayFinalizer) {
			if err := r.cleanupRBAC(ctx, &gateway); err != nil {
				return ctrl.Result{}, fmt.Errorf("cleaning up RBAC: %w", err)
			}
			controllerutil.RemoveFinalizer(&gateway, gatewayFinalizer)
			if err := r.Update(ctx, &gateway); err != nil {
				return ctrl.Result{}, err
			}
		}
		return ctrl.Result{}, nil
	}

	// Ensure finalizer is present
	if controllerutil.AddFinalizer(&gateway, gatewayFinalizer) {
		if err := r.Update(ctx, &gateway); err != nil {
			return ctrl.Result{}, err
		}
	}

	log.Info("Reconciling Gateway", "gateway", gateway.Name, "namespace", gateway.Namespace)

	// Derive ports and detect mode
	ports := DerivePorts(&gateway)
	networks, err := ExtractNetworkNames(&gateway)
	if err != nil {
		r.Recorder.Eventf(&gateway, corev1.EventTypeWarning, "InvalidNetwork", "Invalid network name: %v", err)
		apimeta.SetStatusCondition(&gateway.Status.Conditions, metav1.Condition{
			Type:               string(gatewayv1.GatewayConditionAccepted),
			Status:             metav1.ConditionFalse,
			ObservedGeneration: gateway.Generation,
			LastTransitionTime: metav1.Now(),
			Reason:             string(gatewayv1.GatewayReasonInvalidParameters),
			Message:            err.Error(),
		})
		if statusErr := r.Status().Update(ctx, &gateway); statusErr != nil {
			log.Error(statusErr, "Failed to update Gateway status")
		}
		return ctrl.Result{}, nil
	}

	// Ensure ServiceAccount exists for the data plane
	desiredSA := BuildServiceAccount(gateway.Namespace, r.ServiceAccountName)
	if err := r.Patch(ctx, desiredSA, client.Apply, client.FieldOwner("portail-operator"), client.ForceOwnership); err != nil {
		r.Recorder.Eventf(&gateway, corev1.EventTypeWarning, "ServiceAccountFailed", "Failed to apply ServiceAccount: %v", err)
		return ctrl.Result{}, fmt.Errorf("applying ServiceAccount: %w", err)
	}

	// Reconcile the shared ClusterRoleBinding with subjects from all namespaces
	if err := r.reconcileClusterRoleBinding(ctx, &gateway); err != nil {
		r.Recorder.Eventf(&gateway, corev1.EventTypeWarning, "ClusterRoleBindingFailed", "Failed to reconcile ClusterRoleBinding: %v", err)
		return ctrl.Result{}, fmt.Errorf("reconciling ClusterRoleBinding: %w", err)
	}
	r.Recorder.Eventf(&gateway, corev1.EventTypeNormal, "RBACApplied", "RBAC applied for %q", r.ServiceAccountName)

	desiredDeploy, err := BuildDeployment(&gateway, ports, r.Image, r.ControllerName, r.ServiceAccountName, r.Replicas, networks)
	if err != nil {
		r.Recorder.Eventf(&gateway, corev1.EventTypeWarning, "InvalidGateway", "Invalid gateway name: %v", err)
		apimeta.SetStatusCondition(&gateway.Status.Conditions, metav1.Condition{
			Type:               string(gatewayv1.GatewayConditionAccepted),
			Status:             metav1.ConditionFalse,
			ObservedGeneration: gateway.Generation,
			LastTransitionTime: metav1.Now(),
			Reason:             string(gatewayv1.GatewayReasonInvalidParameters),
			Message:            err.Error(),
		})
		if statusErr := r.Status().Update(ctx, &gateway); statusErr != nil {
			log.Error(statusErr, "Failed to update Gateway status")
		}
		return ctrl.Result{}, nil
	}

	// Apply Deployment via Server-Side Apply (both modes)
	if err := r.Patch(ctx, desiredDeploy, client.Apply, client.FieldOwner("portail-operator"), client.ForceOwnership); err != nil {
		r.Recorder.Eventf(&gateway, corev1.EventTypeWarning, "DeploymentFailed", "Failed to apply Deployment: %v", err)
		return ctrl.Result{}, fmt.Errorf("applying Deployment: %w", err)
	}
	r.Recorder.Eventf(&gateway, corev1.EventTypeNormal, "DeploymentApplied", "Deployment %q applied", desiredDeploy.Name)
	log.Info("Applied Deployment", "name", desiredDeploy.Name)

	// Apply PodDisruptionBudget
	desiredPDB, err := BuildPodDisruptionBudget(&gateway)
	if err != nil {
		return ctrl.Result{}, fmt.Errorf("building PodDisruptionBudget: %w", err)
	}
	if err := r.Patch(ctx, desiredPDB, client.Apply, client.FieldOwner("portail-operator"), client.ForceOwnership); err != nil {
		r.Recorder.Eventf(&gateway, corev1.EventTypeWarning, "PDBFailed", "Failed to apply PodDisruptionBudget: %v", err)
		return ctrl.Result{}, fmt.Errorf("applying PodDisruptionBudget: %w", err)
	}
	log.Info("Applied PodDisruptionBudget", "name", desiredPDB.Name)

	if len(networks) > 0 {
		// Multi-network mode: no Service needed
		r.Recorder.Eventf(&gateway, corev1.EventTypeNormal, "MultiNetworkMode", "Multi-network mode with networks: %v", networks)
		if err := r.deleteOrphanedService(ctx, &gateway); err != nil {
			return ctrl.Result{}, fmt.Errorf("cleaning up orphaned Service: %w", err)
		}
		if err := r.updateGatewayStatusMultiNetwork(ctx, &gateway, desiredDeploy, networks); err != nil {
			return ctrl.Result{}, fmt.Errorf("updating Gateway status: %w", err)
		}
	} else {
		// LoadBalancer mode
		desiredService, err := BuildService(&gateway, ports)
		if err != nil {
			return ctrl.Result{}, fmt.Errorf("building Service: %w", err)
		}
		if err := r.Patch(ctx, desiredService, client.Apply, client.FieldOwner("portail-operator"), client.ForceOwnership); err != nil {
			r.Recorder.Eventf(&gateway, corev1.EventTypeWarning, "ServiceFailed", "Failed to apply Service: %v", err)
			return ctrl.Result{}, fmt.Errorf("applying Service: %w", err)
		}
		r.Recorder.Eventf(&gateway, corev1.EventTypeNormal, "ServiceApplied", "Service %q applied (LoadBalancer)", desiredService.Name)
		log.Info("Applied Service", "name", desiredService.Name)

		if err := r.updateGatewayStatus(ctx, &gateway, desiredDeploy, desiredService); err != nil {
			return ctrl.Result{}, fmt.Errorf("updating Gateway status: %w", err)
		}
	}

	return ctrl.Result{}, nil
}

// reconcileClusterRoleBinding ensures a single shared ClusterRoleBinding exists
// with subjects for all namespaces that have Gateways managed by this operator.
func (r *GatewayReconciler) reconcileClusterRoleBinding(ctx context.Context, gateway *gatewayv1.Gateway) error {
	subjects, err := r.collectSubjects(ctx)
	if err != nil {
		return err
	}

	// Ensure current gateway's namespace is included
	found := false
	for _, s := range subjects {
		if s.Namespace == gateway.Namespace {
			found = true
			break
		}
	}
	if !found {
		subjects = append(subjects, rbacv1.Subject{
			Kind:      "ServiceAccount",
			Name:      r.ServiceAccountName,
			Namespace: gateway.Namespace,
		})
	}

	desired := BuildClusterRoleBinding(r.DataplaneRoleName, subjects)
	return r.Patch(ctx, desired, client.Apply, client.FieldOwner("portail-operator"), client.ForceOwnership)
}

// collectSubjects lists all Gateways managed by this operator and returns
// deduplicated ServiceAccount subjects, one per namespace.
func (r *GatewayReconciler) collectSubjects(ctx context.Context) ([]rbacv1.Subject, error) {
	var gatewayList gatewayv1.GatewayList
	if err := r.List(ctx, &gatewayList); err != nil {
		return nil, err
	}

	seenNS := make(map[string]bool)
	var subjects []rbacv1.Subject

	for i := range gatewayList.Items {
		gw := &gatewayList.Items[i]
		if gw.DeletionTimestamp != nil {
			continue
		}
		// Verify this gateway belongs to our controller
		var gc gatewayv1.GatewayClass
		if err := r.Get(ctx, types.NamespacedName{Name: string(gw.Spec.GatewayClassName)}, &gc); err != nil {
			continue
		}
		if gc.Spec.ControllerName != gatewayv1.GatewayController(r.ControllerName) {
			continue
		}
		if !seenNS[gw.Namespace] {
			seenNS[gw.Namespace] = true
			subjects = append(subjects, rbacv1.Subject{
				Kind:      "ServiceAccount",
				Name:      r.ServiceAccountName,
				Namespace: gw.Namespace,
			})
		}
	}

	return subjects, nil
}

// cleanupRBAC updates or removes the shared ClusterRoleBinding when a Gateway is deleted.
func (r *GatewayReconciler) cleanupRBAC(ctx context.Context, deletingGateway *gatewayv1.Gateway) error {
	log := log.FromContext(ctx)

	var gatewayList gatewayv1.GatewayList
	if err := r.List(ctx, &gatewayList); err != nil {
		return err
	}

	seenNS := make(map[string]bool)
	var remainingSubjects []rbacv1.Subject

	for i := range gatewayList.Items {
		gw := &gatewayList.Items[i]
		if gw.UID == deletingGateway.UID || gw.DeletionTimestamp != nil {
			continue
		}
		var gc gatewayv1.GatewayClass
		if err := r.Get(ctx, types.NamespacedName{Name: string(gw.Spec.GatewayClassName)}, &gc); err != nil {
			continue
		}
		if gc.Spec.ControllerName != gatewayv1.GatewayController(r.ControllerName) {
			continue
		}
		if !seenNS[gw.Namespace] {
			seenNS[gw.Namespace] = true
			remainingSubjects = append(remainingSubjects, rbacv1.Subject{
				Kind:      "ServiceAccount",
				Name:      r.ServiceAccountName,
				Namespace: gw.Namespace,
			})
		}
	}

	// Clean up namespace-scoped resources if no remaining Gateways exist in this namespace.
	// Treat permission errors as non-fatal: the SA is non-critical and will be cleaned up
	// when the namespace is deleted. Blocking the finalizer on a permission error would
	// leave the Gateway stuck in deletion.
	if !seenNS[deletingGateway.Namespace] {
		log.Info("No remaining Gateways in namespace, cleaning up ServiceAccount",
			"namespace", deletingGateway.Namespace)
		sa := &corev1.ServiceAccount{}
		sa.Name = r.ServiceAccountName
		sa.Namespace = deletingGateway.Namespace
		if err := client.IgnoreNotFound(r.Delete(ctx, sa)); err != nil {
			if apierrors.IsForbidden(err) {
				log.Error(err, "Permission denied deleting ServiceAccount, skipping cleanup")
			} else {
				return err
			}
		}
	}

	if len(remainingSubjects) == 0 {
		log.Info("No remaining Gateways, deleting ClusterRoleBinding")
		crb := &rbacv1.ClusterRoleBinding{}
		crb.Name = ClusterRoleBindingName
		if err := client.IgnoreNotFound(r.Delete(ctx, crb)); err != nil {
			if apierrors.IsForbidden(err) {
				log.Error(err, "Permission denied deleting ClusterRoleBinding, skipping cleanup")
			} else {
				return err
			}
		}
		return nil
	}

	desired := BuildClusterRoleBinding(r.DataplaneRoleName, remainingSubjects)
	return r.Patch(ctx, desired, client.Apply, client.FieldOwner("portail-operator"), client.ForceOwnership)
}

func (r *GatewayReconciler) updateGatewayStatus(ctx context.Context, gateway *gatewayv1.Gateway, deploy *appsv1.Deployment, svc *corev1.Service) error {
	patch := client.MergeFrom(gateway.DeepCopy())
	now := metav1.Now()

	apimeta.SetStatusCondition(&gateway.Status.Conditions, metav1.Condition{
		Type:               string(gatewayv1.GatewayConditionAccepted),
		Status:             metav1.ConditionTrue,
		ObservedGeneration: gateway.Generation,
		LastTransitionTime: now,
		Reason:             string(gatewayv1.GatewayReasonAccepted),
		Message:            "Gateway accepted by portail-operator",
	})

	programmedCondition := r.programmedCondition(ctx, gateway, deploy)
	apimeta.SetStatusCondition(&gateway.Status.Conditions, programmedCondition)

	var currentSvc corev1.Service
	if err := r.Get(ctx, types.NamespacedName{Name: svc.Name, Namespace: svc.Namespace}, &currentSvc); err == nil {
		var addresses []gatewayv1.GatewayStatusAddress
		for _, ingress := range currentSvc.Status.LoadBalancer.Ingress {
			if ingress.IP != "" {
				addrType := gatewayv1.IPAddressType
				addresses = append(addresses, gatewayv1.GatewayStatusAddress{
					Type:  &addrType,
					Value: ingress.IP,
				})
			}
			if ingress.Hostname != "" {
				addrType := gatewayv1.HostnameAddressType
				addresses = append(addresses, gatewayv1.GatewayStatusAddress{
					Type:  &addrType,
					Value: ingress.Hostname,
				})
			}
		}
		gateway.Status.Addresses = addresses
	}

	return r.Status().Patch(ctx, gateway, patch)
}

func (r *GatewayReconciler) programmedCondition(ctx context.Context, gateway *gatewayv1.Gateway, deploy *appsv1.Deployment) metav1.Condition {
	now := metav1.Now()

	var currentDeploy appsv1.Deployment
	if err := r.Get(ctx, types.NamespacedName{Name: deploy.Name, Namespace: deploy.Namespace}, &currentDeploy); err != nil {
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
		r.Recorder.Eventf(gateway, corev1.EventTypeNormal, "DataPlaneReady",
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

	r.Recorder.Eventf(gateway, corev1.EventTypeNormal, "DataPlanePending",
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

func (r *GatewayReconciler) updateGatewayStatusMultiNetwork(ctx context.Context, gateway *gatewayv1.Gateway, deploy *appsv1.Deployment, networks []string) error {
	patch := client.MergeFrom(gateway.DeepCopy())
	now := metav1.Now()

	apimeta.SetStatusCondition(&gateway.Status.Conditions, metav1.Condition{
		Type:               string(gatewayv1.GatewayConditionAccepted),
		Status:             metav1.ConditionTrue,
		ObservedGeneration: gateway.Generation,
		LastTransitionTime: now,
		Reason:             string(gatewayv1.GatewayReasonAccepted),
		Message:            "Gateway accepted by portail-operator",
	})

	programmedCondition := r.programmedCondition(ctx, gateway, deploy)
	apimeta.SetStatusCondition(&gateway.Status.Conditions, programmedCondition)

	var addresses []gatewayv1.GatewayStatusAddress
	for _, net := range networks {
		addrType := NetworkAddressType
		addresses = append(addresses, gatewayv1.GatewayStatusAddress{
			Type:  &addrType,
			Value: net,
		})
	}
	gateway.Status.Addresses = addresses

	return r.Status().Patch(ctx, gateway, patch)
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
