package controller

import (
	"context"
	"fmt"

	corev1 "k8s.io/api/core/v1"
	rbacv1 "k8s.io/api/rbac/v1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/types"
	ctrl "sigs.k8s.io/controller-runtime"
	"sigs.k8s.io/controller-runtime/pkg/client"
	"sigs.k8s.io/controller-runtime/pkg/handler"
	"sigs.k8s.io/controller-runtime/pkg/log"
	"sigs.k8s.io/controller-runtime/pkg/reconcile"
	gatewayv1 "sigs.k8s.io/gateway-api/apis/v1"
)

// DataPlaneRBACReconciler owns the cluster-scoped RBAC shared by every data-plane
// ServiceAccount: a single ClusterRoleBinding whose subjects are the data-plane
// ServiceAccounts of all namespaces that have a Gateway managed by this operator.
//
// It is a singleton reconciler. Every Gateway and GatewayClass event maps to one
// fixed request, and Reconcile recomputes the desired state from the full Gateway
// list rather than acting on the triggering object. Because cleanup happens when
// a Gateway's deletion is observed here, Gateways need no finalizer for RBAC —
// their workloads are reclaimed by owner-reference garbage collection.
type DataPlaneRBACReconciler struct {
	client.Client
	Scheme             *runtime.Scheme
	ControllerName     string
	ServiceAccountName string
	DataplaneRoleName  string
}

// rbacSingletonKey is the fixed request every watched event collapses onto, so
// cluster-wide RBAC is reconciled by a single serialized loop.
var rbacSingletonKey = types.NamespacedName{Name: ClusterRoleBindingName}

// +kubebuilder:rbac:groups=rbac.authorization.k8s.io,resources=clusterrolebindings,verbs=get;list;watch;create;update;patch;delete
// +kubebuilder:rbac:groups="",resources=serviceaccounts,verbs=get;list;watch;delete
// +kubebuilder:rbac:groups=gateway.networking.k8s.io,resources=gateways,verbs=get;list;watch
// +kubebuilder:rbac:groups=gateway.networking.k8s.io,resources=gatewayclasses,verbs=get;list;watch

func (r *DataPlaneRBACReconciler) Reconcile(ctx context.Context, _ ctrl.Request) (ctrl.Result, error) {
	subjects, namespaces, err := r.managedSubjects(ctx)
	if err != nil {
		return ctrl.Result{}, err
	}

	if err := r.reconcileBinding(ctx, subjects); err != nil {
		return ctrl.Result{}, err
	}
	if err := r.cleanupOrphanServiceAccounts(ctx, namespaces); err != nil {
		return ctrl.Result{}, err
	}
	return ctrl.Result{}, nil
}

// managedClassNames returns the set of GatewayClass names implemented by this
// operator, listed once so namespace membership is a map lookup.
func (r *DataPlaneRBACReconciler) managedClassNames(ctx context.Context) (map[string]bool, error) {
	var list gatewayv1.GatewayClassList
	if err := r.List(ctx, &list); err != nil {
		return nil, err
	}
	names := make(map[string]bool)
	for i := range list.Items {
		if list.Items[i].Spec.ControllerName == gatewayv1.GatewayController(r.ControllerName) {
			names[list.Items[i].Name] = true
		}
	}
	return names, nil
}

// managedSubjects returns one data-plane ServiceAccount subject per namespace that
// has at least one live Gateway managed by this operator, plus the set of those
// namespaces. Gateways being deleted are skipped, so observing a deletion shrinks
// the result without any finalizer bookkeeping.
func (r *DataPlaneRBACReconciler) managedSubjects(ctx context.Context) ([]rbacv1.Subject, map[string]bool, error) {
	classes, err := r.managedClassNames(ctx)
	if err != nil {
		return nil, nil, err
	}
	var gateways gatewayv1.GatewayList
	if err := r.List(ctx, &gateways); err != nil {
		return nil, nil, err
	}

	namespaces := make(map[string]bool)
	var subjects []rbacv1.Subject
	for i := range gateways.Items {
		gw := &gateways.Items[i]
		if !gw.DeletionTimestamp.IsZero() {
			continue
		}
		if !classes[string(gw.Spec.GatewayClassName)] || namespaces[gw.Namespace] {
			continue
		}
		namespaces[gw.Namespace] = true
		subjects = append(subjects, rbacv1.Subject{
			Kind:      "ServiceAccount",
			Name:      r.ServiceAccountName,
			Namespace: gw.Namespace,
		})
	}
	return subjects, namespaces, nil
}

// reconcileBinding applies the shared ClusterRoleBinding with the given subjects,
// or deletes it when no managed Gateways remain anywhere in the cluster.
func (r *DataPlaneRBACReconciler) reconcileBinding(ctx context.Context, subjects []rbacv1.Subject) error {
	if len(subjects) == 0 {
		crb := &rbacv1.ClusterRoleBinding{}
		crb.Name = ClusterRoleBindingName
		if err := client.IgnoreNotFound(r.Delete(ctx, crb)); err != nil {
			return fmt.Errorf("deleting ClusterRoleBinding: %w", err)
		}
		return nil
	}
	desired := BuildClusterRoleBinding(r.DataplaneRoleName, subjects)
	if err := r.Apply(ctx, desired, client.FieldOwner("portail-operator"), client.ForceOwnership); err != nil {
		return fmt.Errorf("applying ClusterRoleBinding: %w", err)
	}
	return nil
}

// cleanupOrphanServiceAccounts deletes data-plane ServiceAccounts the operator
// created in namespaces that no longer have a managed Gateway. Permission errors
// are tolerated: the SA is harmless and will be removed with its namespace.
func (r *DataPlaneRBACReconciler) cleanupOrphanServiceAccounts(ctx context.Context, keep map[string]bool) error {
	logger := log.FromContext(ctx)
	var saList corev1.ServiceAccountList
	if err := r.List(ctx, &saList, client.MatchingLabels(baseLabels())); err != nil {
		return fmt.Errorf("listing data-plane ServiceAccounts: %w", err)
	}
	for i := range saList.Items {
		sa := &saList.Items[i]
		if sa.Name != r.ServiceAccountName || keep[sa.Namespace] {
			continue
		}
		if err := client.IgnoreNotFound(r.Delete(ctx, sa)); err != nil {
			if apierrors.IsForbidden(err) {
				logger.Error(err, "Permission denied deleting orphan ServiceAccount, skipping", "namespace", sa.Namespace)
				continue
			}
			return fmt.Errorf("deleting orphan ServiceAccount in %s: %w", sa.Namespace, err)
		}
		logger.Info("Deleted orphan data-plane ServiceAccount", "namespace", sa.Namespace)
	}
	return nil
}

// SetupWithManager wires the singleton: any Gateway or GatewayClass change enqueues
// the one fixed request that drives a full RBAC recompute.
func (r *DataPlaneRBACReconciler) SetupWithManager(mgr ctrl.Manager) error {
	toSingleton := handler.EnqueueRequestsFromMapFunc(func(context.Context, client.Object) []reconcile.Request {
		return []reconcile.Request{{NamespacedName: rbacSingletonKey}}
	})
	return ctrl.NewControllerManagedBy(mgr).
		Named("dataplane-rbac").
		Watches(&gatewayv1.Gateway{}, toSingleton).
		Watches(&gatewayv1.GatewayClass{}, toSingleton).
		Complete(r)
}
