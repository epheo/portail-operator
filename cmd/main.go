/*
Copyright 2026.

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.
*/

package main

import (
	"context"
	"crypto/tls"
	"flag"
	"fmt"
	"os"

	_ "k8s.io/client-go/plugin/pkg/client/auth"

	"k8s.io/apimachinery/pkg/runtime"
	utilruntime "k8s.io/apimachinery/pkg/util/runtime"
	clientgoscheme "k8s.io/client-go/kubernetes/scheme"
	ctrl "sigs.k8s.io/controller-runtime"
	"sigs.k8s.io/controller-runtime/pkg/healthz"
	"sigs.k8s.io/controller-runtime/pkg/log/zap"
	"sigs.k8s.io/controller-runtime/pkg/metrics/filters"
	metricsserver "sigs.k8s.io/controller-runtime/pkg/metrics/server"
	gatewayv1 "sigs.k8s.io/gateway-api/apis/v1"

	"github.com/epheo/portail-operator/internal/controller"
)

var (
	scheme   = runtime.NewScheme()
	setupLog = ctrl.Log.WithName("setup")
)

func init() {
	utilruntime.Must(clientgoscheme.AddToScheme(scheme))
	utilruntime.Must(gatewayv1.Install(scheme))
}

// leaderRunnable wraps a function to require leader election before running.
type leaderRunnable struct {
	fn func(ctx context.Context) error
}

func (r *leaderRunnable) Start(ctx context.Context) error { return r.fn(ctx) }
func (r *leaderRunnable) NeedLeaderElection() bool        { return true }

type config struct {
	metricsAddr             string
	metricsCertPath         string
	metricsCertName         string
	metricsCertKey          string
	probeAddr               string
	enableLeaderElection    bool
	secureMetrics           bool
	enableHTTP2             bool
	controllerName          string
	image                   string
	replicas                int
	serviceAccountName      string
	dataplaneRoleName string
}

func parseFlags() config {
	var cfg config

	flag.StringVar(&cfg.metricsAddr, "metrics-bind-address", "0", "The address the metrics endpoint binds to. "+
		"Use :8443 for HTTPS or :8080 for HTTP, or leave as 0 to disable the metrics service.")
	flag.StringVar(&cfg.probeAddr, "health-probe-bind-address", ":8081", "The address the probe endpoint binds to.")
	flag.BoolVar(&cfg.enableLeaderElection, "leader-elect", false,
		"Enable leader election for controller manager. "+
			"Enabling this will ensure there is only one active controller manager.")
	flag.BoolVar(&cfg.secureMetrics, "metrics-secure", true,
		"If set, the metrics endpoint is served securely via HTTPS. Use --metrics-secure=false to use HTTP instead.")
	flag.StringVar(&cfg.metricsCertPath, "metrics-cert-path", "",
		"The directory that contains the metrics server certificate.")
	flag.StringVar(&cfg.metricsCertName, "metrics-cert-name", "tls.crt", "The name of the metrics server certificate file.")
	flag.StringVar(&cfg.metricsCertKey, "metrics-cert-key", "tls.key", "The name of the metrics server key file.")
	flag.BoolVar(&cfg.enableHTTP2, "enable-http2", false,
		"If set, HTTP/2 will be enabled for the metrics server")
	flag.StringVar(&cfg.controllerName, "controller-name", "portail.epheo.eu/gateway-controller",
		"The controller name to match against GatewayClass spec.controllerName.")
	flag.StringVar(&cfg.image, "image", "ghcr.io/epheo/portail:latest",
		"Container image for managed portail Deployments.")
	flag.IntVar(&cfg.replicas, "default-replicas", 2,
		"Default replica count for managed portail Deployments.")
	flag.StringVar(&cfg.serviceAccountName, "service-account-name", "portail-controller",
		"ServiceAccount name for managed portail data plane pods.")
	flag.StringVar(&cfg.dataplaneRoleName, "dataplane-role-name", "portail-operator-dataplane-role",
		"Name of the static ClusterRole for the data plane (as deployed by kustomize).")

	opts := zap.Options{
		Development: true,
	}
	opts.BindFlags(flag.CommandLine)
	flag.Parse()

	ctrl.SetLogger(zap.New(zap.UseFlagOptions(&opts)))

	return cfg
}

func buildMetricsServerOptions(cfg config) metricsserver.Options {
	var tlsOpts []func(*tls.Config)

	if !cfg.enableHTTP2 {
		tlsOpts = append(tlsOpts, func(c *tls.Config) {
			setupLog.Info("Disabling HTTP/2")
			c.NextProtos = []string{"http/1.1"}
		})
	}

	metricsOpts := metricsserver.Options{
		BindAddress:   cfg.metricsAddr,
		SecureServing: cfg.secureMetrics,
		TLSOpts:       tlsOpts,
	}
	if cfg.secureMetrics {
		metricsOpts.FilterProvider = filters.WithAuthenticationAndAuthorization
	}
	if len(cfg.metricsCertPath) > 0 {
		metricsOpts.CertDir = cfg.metricsCertPath
		metricsOpts.CertName = cfg.metricsCertName
		metricsOpts.KeyName = cfg.metricsCertKey
	}

	return metricsOpts
}

func main() {
	cfg := parseFlags()
	metricsOpts := buildMetricsServerOptions(cfg)

	mgr, err := ctrl.NewManager(ctrl.GetConfigOrDie(), ctrl.Options{
		Scheme:                 scheme,
		Metrics:                metricsOpts,
		HealthProbeBindAddress: cfg.probeAddr,
		LeaderElection:         cfg.enableLeaderElection,
		LeaderElectionID:       "portail-operator.epheo.eu",
	})
	if err != nil {
		setupLog.Error(err, "Failed to start manager")
		os.Exit(1)
	}

	gcReconciler := &controller.GatewayClassReconciler{
		Client:         mgr.GetClient(),
		Scheme:         mgr.GetScheme(),
		Recorder:       mgr.GetEventRecorderFor("gatewayclass-controller"),
		ControllerName: cfg.controllerName,
	}
	if err := gcReconciler.SetupWithManager(mgr); err != nil {
		setupLog.Error(err, "Failed to create controller", "controller", "GatewayClass")
		os.Exit(1)
	}

	// Ensure a default GatewayClass exists after the cache is synced.
	// This runnable requires leader election so it only runs on the active instance.
	if err := mgr.Add(&leaderRunnable{fn: func(ctx context.Context) error {
		if !mgr.GetCache().WaitForCacheSync(ctx) {
			return fmt.Errorf("cache sync failed")
		}
		if err := gcReconciler.EnsureDefaultGatewayClass(ctx); err != nil {
			setupLog.Error(err, "Failed to ensure default GatewayClass")
		}
		return nil
	}}); err != nil {
		setupLog.Error(err, "Failed to add default GatewayClass runnable")
		os.Exit(1)
	}

	if err := (&controller.GatewayReconciler{
		Client:             mgr.GetClient(),
		Scheme:             mgr.GetScheme(),
		Recorder:           mgr.GetEventRecorderFor("gateway-controller"),
		ControllerName:     cfg.controllerName,
		Image:              cfg.image,
		Replicas:           int32(cfg.replicas),
		ServiceAccountName: cfg.serviceAccountName,
		DataplaneRoleName: cfg.dataplaneRoleName,
	}).SetupWithManager(mgr); err != nil {
		setupLog.Error(err, "Failed to create controller", "controller", "Gateway")
		os.Exit(1)
	}

	if err := mgr.AddHealthzCheck("healthz", healthz.Ping); err != nil {
		setupLog.Error(err, "Failed to set up health check")
		os.Exit(1)
	}
	if err := mgr.AddReadyzCheck("readyz", healthz.Ping); err != nil {
		setupLog.Error(err, "Failed to set up ready check")
		os.Exit(1)
	}

	setupLog.Info("Starting portail-operator",
		"controllerName", cfg.controllerName,
		"image", cfg.image,
		"replicas", cfg.replicas,
	)
	if err := mgr.Start(ctrl.SetupSignalHandler()); err != nil {
		setupLog.Error(err, "Failed to run manager")
		os.Exit(1)
	}
}
