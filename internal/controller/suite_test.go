package controller

import (
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"testing"

	"k8s.io/apimachinery/pkg/runtime"
	utilruntime "k8s.io/apimachinery/pkg/util/runtime"
	clientgoscheme "k8s.io/client-go/kubernetes/scheme"
	"k8s.io/client-go/rest"
	"sigs.k8s.io/controller-runtime/pkg/client"
	"sigs.k8s.io/controller-runtime/pkg/envtest"
	gatewayv1 "sigs.k8s.io/gateway-api/apis/v1"
)

// Reconciler configuration shared by the envtest-backed tests. Mirrors the
// defaults wired in cmd/main.go.
const (
	testControllerName    = "portail.epheo.eu/gateway-controller"
	testImage             = "ghcr.io/epheo/portail:latest"
	testReplicas          = 2
	testSAName            = "portail-controller"
	testDataplaneRoleName = "portail-operator-dataplane-role"
	testGatewayClass      = "portail"
)

var (
	testEnv     *envtest.Environment
	testCfg     *rest.Config
	envClient   client.Client
	envScheme   *runtime.Scheme
	envOnce     sync.Once
	envStartErr error
	envSkip     bool

	errNoAssets = errors.New("envtest binaries not found")
)

// TestMain runs the package tests and tears down the shared envtest API server
// if any test started it. It deliberately does not start envtest, so the pure
// builder unit tests in this package run even when envtest binaries are absent.
func TestMain(m *testing.M) {
	code := m.Run()
	if testEnv != nil {
		_ = testEnv.Stop()
	}
	os.Exit(code)
}

// requireEnvtest lazily starts a single shared envtest environment and returns a
// direct (uncached) client. When the envtest binaries cannot be located the
// calling test is skipped rather than failed, so `go test ./internal/...` works
// without `make test` having staged the assets.
func requireEnvtest(t *testing.T) client.Client {
	t.Helper()
	envOnce.Do(startEnvtest)
	if envSkip {
		t.Skipf("skipping envtest: %v (run `make test` or set KUBEBUILDER_ASSETS)", envStartErr)
	}
	if envStartErr != nil {
		t.Fatalf("starting envtest: %v", envStartErr)
	}
	return envClient
}

func startEnvtest() {
	assets, ok := resolveBinaryAssets()
	if !ok {
		envSkip = true
		envStartErr = errNoAssets
		return
	}

	crdPaths, err := gatewayCRDPaths()
	if err != nil {
		envStartErr = err
		return
	}

	envScheme = runtime.NewScheme()
	utilruntime.Must(clientgoscheme.AddToScheme(envScheme))
	utilruntime.Must(gatewayv1.Install(envScheme))

	testEnv = &envtest.Environment{
		CRDDirectoryPaths:     crdPaths,
		ErrorIfCRDPathMissing: true,
		BinaryAssetsDirectory: assets,
	}

	testCfg, envStartErr = testEnv.Start()
	if envStartErr != nil {
		return
	}
	envClient, envStartErr = client.New(testCfg, client.Options{Scheme: envScheme})
}

// resolveBinaryAssets locates the kube-apiserver/etcd binaries. It honours
// KUBEBUILDER_ASSETS (set by `make test`) and otherwise falls back to the
// repo-local bin/k8s/<version> directory populated by setup-envtest.
func resolveBinaryAssets() (string, bool) {
	if os.Getenv("KUBEBUILDER_ASSETS") != "" {
		// Returning an empty path lets envtest read KUBEBUILDER_ASSETS itself.
		return "", true
	}
	matches, _ := filepath.Glob(filepath.Join("..", "..", "bin", "k8s", "*"))
	for _, m := range matches {
		if info, statErr := os.Stat(m); statErr == nil && info.IsDir() {
			return m, true
		}
	}
	return "", false
}

// gatewayCRDPaths returns the standard-channel Gateway and GatewayClass CRD files
// from the gateway-api module cache. Only these two are installed: the operator
// reconciles Gateway/GatewayClass and never the route kinds (those belong to the
// data plane), and the standard directory also ships a non-CRD VAP manifest that
// the CRD installer would choke on.
func gatewayCRDPaths() ([]string, error) {
	out, err := exec.Command("go", "list", "-m", "-f", "{{.Dir}}", "sigs.k8s.io/gateway-api").Output()
	if err != nil {
		return nil, fmt.Errorf("locating gateway-api module: %w", err)
	}
	base := filepath.Join(strings.TrimSpace(string(out)), "config", "crd", "standard")
	return []string{
		filepath.Join(base, "gateway.networking.k8s.io_gateways.yaml"),
		filepath.Join(base, "gateway.networking.k8s.io_gatewayclasses.yaml"),
	}, nil
}
