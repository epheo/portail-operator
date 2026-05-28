package controller

import (
	"context"

	corev1 "k8s.io/api/core/v1"
	apimeta "k8s.io/apimachinery/pkg/api/meta"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/types"
	"k8s.io/client-go/tools/events"
	ctrl "sigs.k8s.io/controller-runtime"
	"sigs.k8s.io/controller-runtime/pkg/client"
	"sigs.k8s.io/controller-runtime/pkg/controller/controllerutil"
	"sigs.k8s.io/controller-runtime/pkg/handler"
	"sigs.k8s.io/controller-runtime/pkg/log"
	"sigs.k8s.io/controller-runtime/pkg/reconcile"
	gatewayv1 "sigs.k8s.io/gateway-api/apis/v1"
)

const gatewayClassFinalizer = "gateway-exists-finalizer.gateway.networking.k8s.io"

// GatewayClassReconciler reconciles GatewayClass objects by setting status conditions
// and managing the gateway-exists finalizer.
type GatewayClassReconciler struct {
	client.Client
	Scheme         *runtime.Scheme
	Recorder       events.EventRecorder
	ControllerName string
}

// +kubebuilder:rbac:groups=gateway.networking.k8s.io,resources=gatewayclasses,verbs=get;list;watch;create;update
// +kubebuilder:rbac:groups=gateway.networking.k8s.io,resources=gatewayclasses/status,verbs=update

// DefaultGatewayClassName is the name of the GatewayClass created at startup.
const DefaultGatewayClassName = "portail"

// EnsureDefaultGatewayClass creates a default GatewayClass if none exists for this controller.
func (r *GatewayClassReconciler) EnsureDefaultGatewayClass(ctx context.Context) error {
	logger := log.FromContext(ctx)

	var gcList gatewayv1.GatewayClassList
	if err := r.List(ctx, &gcList); err != nil {
		return err
	}
	for i := range gcList.Items {
		if gcList.Items[i].Spec.ControllerName == gatewayv1.GatewayController(r.ControllerName) {
			logger.Info("GatewayClass already exists for controller", "name", gcList.Items[i].Name)
			return nil
		}
	}

	gc := &gatewayv1.GatewayClass{
		ObjectMeta: metav1.ObjectMeta{
			Name: DefaultGatewayClassName,
			Labels: map[string]string{
				"app.kubernetes.io/name":       "portail",
				"app.kubernetes.io/managed-by": "portail-operator",
			},
		},
		Spec: gatewayv1.GatewayClassSpec{
			ControllerName: gatewayv1.GatewayController(r.ControllerName),
		},
	}
	if err := r.Create(ctx, gc); err != nil {
		return err
	}
	logger.Info("Created default GatewayClass", "name", DefaultGatewayClassName)
	return nil
}

func (r *GatewayClassReconciler) Reconcile(ctx context.Context, req ctrl.Request) (ctrl.Result, error) {
	logger := log.FromContext(ctx)

	var gc gatewayv1.GatewayClass
	if err := r.Get(ctx, req.NamespacedName, &gc); err != nil {
		return ctrl.Result{}, client.IgnoreNotFound(err)
	}

	// Only manage GatewayClasses that reference our controller
	if gc.Spec.ControllerName != gatewayv1.GatewayController(r.ControllerName) {
		return ctrl.Result{}, nil
	}

	logger.Info("Reconciling GatewayClass", "name", gc.Name)

	// List Gateways referencing this GatewayClass
	var gatewayList gatewayv1.GatewayList
	if err := r.List(ctx, &gatewayList); err != nil {
		return ctrl.Result{}, err
	}
	hasGateways := false
	for i := range gatewayList.Items {
		if string(gatewayList.Items[i].Spec.GatewayClassName) == gc.Name {
			hasGateways = true
			break
		}
	}

	// Handle finalizer
	if hasGateways {
		if controllerutil.AddFinalizer(&gc, gatewayClassFinalizer) {
			if err := r.Update(ctx, &gc); err != nil {
				return ctrl.Result{}, err
			}
			r.Recorder.Eventf(&gc, nil, corev1.EventTypeNormal, "FinalizerAdded", "FinalizerAdded", "Added gateway-exists finalizer")
		}
	} else {
		if controllerutil.RemoveFinalizer(&gc, gatewayClassFinalizer) {
			if err := r.Update(ctx, &gc); err != nil {
				return ctrl.Result{}, err
			}
			r.Recorder.Eventf(&gc, nil, corev1.EventTypeNormal, "FinalizerRemoved", "FinalizerRemoved", "Removed gateway-exists finalizer")
		}
		// If being deleted and finalizer is now removed, we're done
		if !gc.DeletionTimestamp.IsZero() {
			return ctrl.Result{}, nil
		}
	}

	// Set Accepted condition
	apimeta.SetStatusCondition(&gc.Status.Conditions, metav1.Condition{
		Type:               string(gatewayv1.GatewayClassConditionStatusAccepted),
		Status:             metav1.ConditionTrue,
		ObservedGeneration: gc.Generation,
		LastTransitionTime: metav1.Now(),
		Reason:             string(gatewayv1.GatewayClassReasonAccepted),
		Message:            "GatewayClass accepted by portail-operator",
	})

	if err := r.Status().Update(ctx, &gc); err != nil {
		return ctrl.Result{}, err
	}
	r.Recorder.Eventf(&gc, nil, corev1.EventTypeNormal, "Accepted", "Accepted", "GatewayClass accepted")

	return ctrl.Result{}, nil
}

// gatewayToGatewayClass maps a Gateway to a reconcile request for its GatewayClass.
func (r *GatewayClassReconciler) gatewayToGatewayClass(ctx context.Context, obj client.Object) []reconcile.Request {
	gw, ok := obj.(*gatewayv1.Gateway)
	if !ok {
		return nil
	}
	return []reconcile.Request{
		{NamespacedName: types.NamespacedName{Name: string(gw.Spec.GatewayClassName)}},
	}
}

// SetupWithManager registers the GatewayClass controller with the manager.
func (r *GatewayClassReconciler) SetupWithManager(mgr ctrl.Manager) error {
	return ctrl.NewControllerManagedBy(mgr).
		For(&gatewayv1.GatewayClass{}).
		Watches(&gatewayv1.Gateway{}, handler.EnqueueRequestsFromMapFunc(r.gatewayToGatewayClass)).
		Complete(r)
}
