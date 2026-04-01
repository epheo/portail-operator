//go:build e2e
// +build e2e

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

package e2e

import (
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"

	. "github.com/onsi/ginkgo/v2"
	. "github.com/onsi/gomega"

	"github.com/epheo/portail-operator/test/utils"
)

// namespace where the project is deployed in
const namespace = "portail-operator-system"

// serviceAccountName created for the project
const serviceAccountName = "portail-operator-controller-manager"

// metricsServiceName is the name of the metrics service of the project
const metricsServiceName = "portail-operator-controller-manager-metrics-service"

// metricsRoleBindingName is the name of the RBAC that will be created to allow get the metrics data
const metricsRoleBindingName = "portail-operator-metrics-binding"

var _ = Describe("Manager", Ordered, func() {
	var controllerPodName string

	// Before running the tests, set up the environment by creating the namespace,
	// enforce the restricted security policy to the namespace, installing CRDs,
	// and deploying the controller.
	BeforeAll(func() {
		By("creating manager namespace")
		cmd := exec.Command("kubectl", "create", "ns", namespace)
		_, err := utils.Run(cmd)
		Expect(err).NotTo(HaveOccurred(), "Failed to create namespace")

		By("labeling the namespace to enforce the restricted security policy")
		cmd = exec.Command("kubectl", "label", "--overwrite", "ns", namespace,
			"pod-security.kubernetes.io/enforce=restricted")
		_, err = utils.Run(cmd)
		Expect(err).NotTo(HaveOccurred(), "Failed to label namespace with restricted policy")

		By("installing Gateway API CRDs")
		cmd = exec.Command("kubectl", "apply", "-f",
			"https://github.com/kubernetes-sigs/gateway-api/releases/download/v1.5.1/standard-install.yaml")
		_, err = utils.Run(cmd)
		Expect(err).NotTo(HaveOccurred(), "Failed to install Gateway API CRDs")

		By("deploying the controller-manager")
		cmd = exec.Command("make", "deploy", fmt.Sprintf("IMG=%s", managerImage))
		_, err = utils.Run(cmd)
		Expect(err).NotTo(HaveOccurred(), "Failed to deploy the controller-manager")
	})

	// After all tests have been executed, clean up by undeploying the controller, uninstalling CRDs,
	// and deleting the namespace.
	AfterAll(func() {
		By("cleaning up the curl pod for metrics")
		cmd := exec.Command("kubectl", "delete", "pod", "curl-metrics", "-n", namespace)
		_, _ = utils.Run(cmd)

		By("undeploying the controller-manager")
		cmd = exec.Command("make", "undeploy")
		_, _ = utils.Run(cmd)

		By("uninstalling Gateway API CRDs")
		cmd = exec.Command("kubectl", "delete", "-f",
			"https://github.com/kubernetes-sigs/gateway-api/releases/download/v1.5.1/standard-install.yaml")
		_, _ = utils.Run(cmd)

		By("removing manager namespace")
		cmd = exec.Command("kubectl", "delete", "ns", namespace)
		_, _ = utils.Run(cmd)
	})

	// After each test, check for failures and collect logs, events,
	// and pod descriptions for debugging.
	AfterEach(func() {
		specReport := CurrentSpecReport()
		if specReport.Failed() {
			By("Fetching controller manager pod logs")
			cmd := exec.Command("kubectl", "logs", controllerPodName, "-n", namespace)
			controllerLogs, err := utils.Run(cmd)
			if err == nil {
				_, _ = fmt.Fprintf(GinkgoWriter, "Controller logs:\n %s", controllerLogs)
			} else {
				_, _ = fmt.Fprintf(GinkgoWriter, "Failed to get Controller logs: %s", err)
			}

			By("Fetching Kubernetes events")
			cmd = exec.Command("kubectl", "get", "events", "-n", namespace, "--sort-by=.lastTimestamp")
			eventsOutput, err := utils.Run(cmd)
			if err == nil {
				_, _ = fmt.Fprintf(GinkgoWriter, "Kubernetes events:\n%s", eventsOutput)
			} else {
				_, _ = fmt.Fprintf(GinkgoWriter, "Failed to get Kubernetes events: %s", err)
			}

			By("Fetching curl-metrics logs")
			cmd = exec.Command("kubectl", "logs", "curl-metrics", "-n", namespace)
			metricsOutput, err := utils.Run(cmd)
			if err == nil {
				_, _ = fmt.Fprintf(GinkgoWriter, "Metrics logs:\n %s", metricsOutput)
			} else {
				_, _ = fmt.Fprintf(GinkgoWriter, "Failed to get curl-metrics logs: %s", err)
			}

			By("Fetching controller manager pod description")
			cmd = exec.Command("kubectl", "describe", "pod", controllerPodName, "-n", namespace)
			podDescription, err := utils.Run(cmd)
			if err == nil {
				fmt.Println("Pod description:\n", podDescription)
			} else {
				fmt.Println("Failed to describe controller pod")
			}
		}
	})

	SetDefaultEventuallyTimeout(2 * time.Minute)
	SetDefaultEventuallyPollingInterval(time.Second)

	Context("Manager", func() {
		It("should run successfully", func() {
			By("validating that the controller-manager pod is running as expected")
			verifyControllerUp := func(g Gomega) {
				// Get the name of the controller-manager pod
				cmd := exec.Command("kubectl", "get",
					"pods", "-l", "control-plane=controller-manager",
					"-o", "go-template={{ range .items }}"+
						"{{ if not .metadata.deletionTimestamp }}"+
						"{{ .metadata.name }}"+
						"{{ \"\\n\" }}{{ end }}{{ end }}",
					"-n", namespace,
				)

				podOutput, err := utils.Run(cmd)
				g.Expect(err).NotTo(HaveOccurred(), "Failed to retrieve controller-manager pod information")
				podNames := utils.GetNonEmptyLines(podOutput)
				g.Expect(podNames).To(HaveLen(1), "expected 1 controller pod running")
				controllerPodName = podNames[0]
				g.Expect(controllerPodName).To(ContainSubstring("controller-manager"))

				// Validate the pod's status
				cmd = exec.Command("kubectl", "get",
					"pods", controllerPodName, "-o", "jsonpath={.status.phase}",
					"-n", namespace,
				)
				output, err := utils.Run(cmd)
				g.Expect(err).NotTo(HaveOccurred())
				g.Expect(output).To(Equal("Running"), "Incorrect controller-manager pod status")
			}
			Eventually(verifyControllerUp).Should(Succeed())
		})

		It("should ensure the metrics endpoint is serving metrics", func() {
			By("creating a ClusterRoleBinding for the service account to allow access to metrics")
			cmd := exec.Command("kubectl", "create", "clusterrolebinding", metricsRoleBindingName,
				"--clusterrole=portail-operator-metrics-reader",
				fmt.Sprintf("--serviceaccount=%s:%s", namespace, serviceAccountName),
			)
			_, err := utils.Run(cmd)
			Expect(err).NotTo(HaveOccurred(), "Failed to create ClusterRoleBinding")

			By("validating that the metrics service is available")
			cmd = exec.Command("kubectl", "get", "service", metricsServiceName, "-n", namespace)
			_, err = utils.Run(cmd)
			Expect(err).NotTo(HaveOccurred(), "Metrics service should exist")

			By("getting the service account token")
			token, err := serviceAccountToken()
			Expect(err).NotTo(HaveOccurred())
			Expect(token).NotTo(BeEmpty())

			By("ensuring the controller pod is ready")
			verifyControllerPodReady := func(g Gomega) {
				cmd := exec.Command("kubectl", "get", "pod", controllerPodName, "-n", namespace,
					"-o", "jsonpath={.status.conditions[?(@.type=='Ready')].status}")
				output, err := utils.Run(cmd)
				g.Expect(err).NotTo(HaveOccurred())
				g.Expect(output).To(Equal("True"), "Controller pod not ready")
			}
			Eventually(verifyControllerPodReady, 3*time.Minute, time.Second).Should(Succeed())

			By("verifying that the controller manager is serving the metrics server")
			verifyMetricsServerStarted := func(g Gomega) {
				cmd := exec.Command("kubectl", "logs", controllerPodName, "-n", namespace)
				output, err := utils.Run(cmd)
				g.Expect(err).NotTo(HaveOccurred())
				g.Expect(output).To(ContainSubstring("Serving metrics server"),
					"Metrics server not yet started")
			}
			Eventually(verifyMetricsServerStarted, 3*time.Minute, time.Second).Should(Succeed())

			// +kubebuilder:scaffold:e2e-metrics-webhooks-readiness

			By("creating the curl-metrics pod to access the metrics endpoint")
			cmd = exec.Command("kubectl", "run", "curl-metrics", "--restart=Never",
				"--namespace", namespace,
				"--image=curlimages/curl:latest",
				"--overrides",
				fmt.Sprintf(`{
					"spec": {
						"containers": [{
							"name": "curl",
							"image": "curlimages/curl:latest",
							"command": ["/bin/sh", "-c"],
							"args": [
								"for i in $(seq 1 30); do curl -v -k -H 'Authorization: Bearer %s' https://%s.%s.svc.cluster.local:8443/metrics && exit 0 || sleep 2; done; exit 1"
							],
							"securityContext": {
								"readOnlyRootFilesystem": true,
								"allowPrivilegeEscalation": false,
								"capabilities": {
									"drop": ["ALL"]
								},
								"runAsNonRoot": true,
								"runAsUser": 1000,
								"seccompProfile": {
									"type": "RuntimeDefault"
								}
							}
						}],
						"serviceAccountName": "%s"
					}
				}`, token, metricsServiceName, namespace, serviceAccountName))
			_, err = utils.Run(cmd)
			Expect(err).NotTo(HaveOccurred(), "Failed to create curl-metrics pod")

			By("waiting for the curl-metrics pod to complete.")
			verifyCurlUp := func(g Gomega) {
				cmd := exec.Command("kubectl", "get", "pods", "curl-metrics",
					"-o", "jsonpath={.status.phase}",
					"-n", namespace)
				output, err := utils.Run(cmd)
				g.Expect(err).NotTo(HaveOccurred())
				g.Expect(output).To(Equal("Succeeded"), "curl pod in wrong status")
			}
			Eventually(verifyCurlUp, 5*time.Minute).Should(Succeed())

			By("getting the metrics by checking curl-metrics logs")
			verifyMetricsAvailable := func(g Gomega) {
				metricsOutput, err := getMetricsOutput()
				g.Expect(err).NotTo(HaveOccurred(), "Failed to retrieve logs from curl pod")
				g.Expect(metricsOutput).NotTo(BeEmpty())
				g.Expect(metricsOutput).To(ContainSubstring("< HTTP/1.1 200 OK"))
			}
			Eventually(verifyMetricsAvailable, 2*time.Minute).Should(Succeed())
		})

		// +kubebuilder:scaffold:e2e-webhooks-checks

		It("should reconcile a Gateway into a Deployment and Service", func() {
			const testNS = "default"

			By("creating a GatewayClass")
			cmd := exec.Command("kubectl", "apply", "-f", "-")
			cmd.Stdin = strings.NewReader(`
apiVersion: gateway.networking.k8s.io/v1
kind: GatewayClass
metadata:
  name: portail-e2e
spec:
  controllerName: portail.epheo.eu/gateway-controller
`)
			_, err := utils.Run(cmd)
			Expect(err).NotTo(HaveOccurred(), "Failed to create GatewayClass")

			By("verifying the GatewayClass is accepted")
			verifyGatewayClassAccepted := func(g Gomega) {
				cmd := exec.Command("kubectl", "get", "gatewayclass", "portail-e2e",
					"-o", "jsonpath={.status.conditions[?(@.type=='Accepted')].status}")
				output, err := utils.Run(cmd)
				g.Expect(err).NotTo(HaveOccurred())
				g.Expect(output).To(Equal("True"), "GatewayClass not accepted")
			}
			Eventually(verifyGatewayClassAccepted).Should(Succeed())

			By("creating a Gateway")
			cmd = exec.Command("kubectl", "apply", "-f", "-")
			cmd.Stdin = strings.NewReader(`
apiVersion: gateway.networking.k8s.io/v1
kind: Gateway
metadata:
  name: e2e-test
  namespace: default
spec:
  gatewayClassName: portail-e2e
  listeners:
  - name: http
    protocol: HTTP
    port: 80
`)
			_, err = utils.Run(cmd)
			Expect(err).NotTo(HaveOccurred(), "Failed to create Gateway")

			By("verifying the Gateway status shows Accepted and Programmed=False (data plane image not available)")
			verifyGatewayStatus := func(g Gomega) {
				cmd := exec.Command("kubectl", "get", "gateway", "e2e-test", "-n", testNS,
					"-o", "jsonpath={.status.conditions[?(@.type=='Accepted')].status}")
				output, err := utils.Run(cmd)
				g.Expect(err).NotTo(HaveOccurred())
				g.Expect(output).To(Equal("True"), "Gateway not accepted")

				cmd = exec.Command("kubectl", "get", "gateway", "e2e-test", "-n", testNS,
					"-o", "jsonpath={.status.conditions[?(@.type=='Programmed')].reason}")
				output, err = utils.Run(cmd)
				g.Expect(err).NotTo(HaveOccurred())
				g.Expect(output).To(Equal("Pending"), "Expected Programmed=Pending while data plane is not ready")
			}
			Eventually(verifyGatewayStatus).Should(Succeed())

			By("verifying the data plane Deployment was created")
			verifyDeployment := func(g Gomega) {
				cmd := exec.Command("kubectl", "get", "deployment", "portail-e2e-test",
					"-n", testNS, "-o", "jsonpath={.spec.replicas}")
				output, err := utils.Run(cmd)
				g.Expect(err).NotTo(HaveOccurred())
				g.Expect(output).To(Equal("2"), "Unexpected replica count")
			}
			Eventually(verifyDeployment).Should(Succeed())

			By("verifying the LoadBalancer Service was created with correct ports")
			verifyService := func(g Gomega) {
				cmd := exec.Command("kubectl", "get", "service", "portail-e2e-test",
					"-n", testNS, "-o", "jsonpath={.spec.type}")
				output, err := utils.Run(cmd)
				g.Expect(err).NotTo(HaveOccurred())
				g.Expect(output).To(Equal("LoadBalancer"), "Service is not LoadBalancer type")

				cmd = exec.Command("kubectl", "get", "service", "portail-e2e-test",
					"-n", testNS, "-o", "jsonpath={.spec.ports[0].port}")
				output, err = utils.Run(cmd)
				g.Expect(err).NotTo(HaveOccurred())
				g.Expect(output).To(Equal("80"), "Service port mismatch")
			}
			Eventually(verifyService).Should(Succeed())

			By("verifying the GatewayClass has the gateway-exists finalizer")
			cmd = exec.Command("kubectl", "get", "gatewayclass", "portail-e2e",
				"-o", "jsonpath={.metadata.finalizers}")
			output, err := utils.Run(cmd)
			Expect(err).NotTo(HaveOccurred())
			Expect(output).To(ContainSubstring("gateway-exists-finalizer.gateway.networking.k8s.io"))

			By("deleting the Gateway and verifying cleanup")
			cmd = exec.Command("kubectl", "delete", "gateway", "e2e-test", "-n", testNS)
			_, err = utils.Run(cmd)
			Expect(err).NotTo(HaveOccurred())

			verifyDeploymentGone := func(g Gomega) {
				cmd := exec.Command("kubectl", "get", "deployment", "portail-e2e-test",
					"-n", testNS)
				_, err := utils.Run(cmd)
				g.Expect(err).To(HaveOccurred(), "Deployment should be garbage collected")
			}
			Eventually(verifyDeploymentGone).Should(Succeed())

			verifyServiceGone := func(g Gomega) {
				cmd := exec.Command("kubectl", "get", "service", "portail-e2e-test",
					"-n", testNS)
				_, err := utils.Run(cmd)
				g.Expect(err).To(HaveOccurred(), "Service should be garbage collected")
			}
			Eventually(verifyServiceGone).Should(Succeed())

			By("verifying the finalizer is removed after the last Gateway is deleted")
			verifyFinalizerRemoved := func(g Gomega) {
				cmd := exec.Command("kubectl", "get", "gatewayclass", "portail-e2e",
					"-o", "jsonpath={.metadata.finalizers}")
				output, err := utils.Run(cmd)
				g.Expect(err).NotTo(HaveOccurred())
				g.Expect(output).NotTo(ContainSubstring("gateway-exists-finalizer"))
			}
			Eventually(verifyFinalizerRemoved).Should(Succeed())

			By("cleaning up the GatewayClass")
			cmd = exec.Command("kubectl", "delete", "gatewayclass", "portail-e2e")
			_, _ = utils.Run(cmd)
		})

		It("should reconcile a multi-network Gateway into a Deployment without a Service", func() {
			const testNS = "default"

			By("creating a GatewayClass for multi-network")
			cmd := exec.Command("kubectl", "apply", "-f", "-")
			cmd.Stdin = strings.NewReader(`
apiVersion: gateway.networking.k8s.io/v1
kind: GatewayClass
metadata:
  name: portail-multi-net
spec:
  controllerName: portail.epheo.eu/gateway-controller
`)
			_, err := utils.Run(cmd)
			Expect(err).NotTo(HaveOccurred(), "Failed to create GatewayClass")

			By("verifying the GatewayClass is accepted")
			verifyGCAccepted := func(g Gomega) {
				cmd := exec.Command("kubectl", "get", "gatewayclass", "portail-multi-net",
					"-o", "jsonpath={.status.conditions[?(@.type=='Accepted')].status}")
				output, err := utils.Run(cmd)
				g.Expect(err).NotTo(HaveOccurred())
				g.Expect(output).To(Equal("True"), "GatewayClass not accepted")
			}
			Eventually(verifyGCAccepted).Should(Succeed())

			By("creating a multi-network Gateway")
			cmd = exec.Command("kubectl", "apply", "-f", "-")
			cmd.Stdin = strings.NewReader(`
apiVersion: gateway.networking.k8s.io/v1
kind: Gateway
metadata:
  name: e2e-multi-net
  namespace: default
spec:
  gatewayClassName: portail-multi-net
  addresses:
  - type: portail.epheo.eu/Network
    value: net-a
  - type: portail.epheo.eu/Network
    value: net-b
  listeners:
  - name: http
    protocol: HTTP
    port: 8080
`)
			_, err = utils.Run(cmd)
			Expect(err).NotTo(HaveOccurred(), "Failed to create multi-network Gateway")

			By("verifying the Gateway status shows Accepted and Programmed=Pending")
			verifyGatewayStatus := func(g Gomega) {
				cmd := exec.Command("kubectl", "get", "gateway", "e2e-multi-net", "-n", testNS,
					"-o", "jsonpath={.status.conditions[?(@.type=='Accepted')].status}")
				output, err := utils.Run(cmd)
				g.Expect(err).NotTo(HaveOccurred())
				g.Expect(output).To(Equal("True"), "Gateway not accepted")

				cmd = exec.Command("kubectl", "get", "gateway", "e2e-multi-net", "-n", testNS,
					"-o", "jsonpath={.status.conditions[?(@.type=='Programmed')].reason}")
				output, err = utils.Run(cmd)
				g.Expect(err).NotTo(HaveOccurred())
				g.Expect(output).To(Equal("Pending"), "Expected Programmed=Pending while data plane is not ready")
			}
			Eventually(verifyGatewayStatus).Should(Succeed())

			By("verifying the Gateway status addresses contain the network names")
			verifyAddresses := func(g Gomega) {
				cmd := exec.Command("kubectl", "get", "gateway", "e2e-multi-net", "-n", testNS,
					"-o", "jsonpath={.status.addresses[*].value}")
				output, err := utils.Run(cmd)
				g.Expect(err).NotTo(HaveOccurred())
				g.Expect(output).To(ContainSubstring("net-a"))
				g.Expect(output).To(ContainSubstring("net-b"))
			}
			Eventually(verifyAddresses).Should(Succeed())

			By("verifying the Deployment has the Multus network annotation")
			verifyDeployment := func(g Gomega) {
				cmd := exec.Command("kubectl", "get", "deployment", "portail-e2e-multi-net",
					"-n", testNS, "-o",
					`jsonpath={.spec.template.metadata.annotations.k8s\.v1\.cni\.cncf\.io/networks}`)
				output, err := utils.Run(cmd)
				g.Expect(err).NotTo(HaveOccurred())
				g.Expect(output).To(Equal("net-a, net-b"), "Unexpected network annotation")

				cmd = exec.Command("kubectl", "get", "deployment", "portail-e2e-multi-net",
					"-n", testNS, "-o", "jsonpath={.spec.replicas}")
				output, err = utils.Run(cmd)
				g.Expect(err).NotTo(HaveOccurred())
				g.Expect(output).To(Equal("2"), "Unexpected replica count")
			}
			Eventually(verifyDeployment).Should(Succeed())

			By("verifying no LoadBalancer Service was created")
			cmd = exec.Command("kubectl", "get", "service", "portail-e2e-multi-net", "-n", testNS)
			_, err = utils.Run(cmd)
			Expect(err).To(HaveOccurred(), "Service should not exist in multi-network mode")

			By("deleting the Gateway and verifying cleanup")
			cmd = exec.Command("kubectl", "delete", "gateway", "e2e-multi-net", "-n", testNS)
			_, err = utils.Run(cmd)
			Expect(err).NotTo(HaveOccurred())

			verifyDeploymentGone := func(g Gomega) {
				cmd := exec.Command("kubectl", "get", "deployment", "portail-e2e-multi-net",
					"-n", testNS)
				_, err := utils.Run(cmd)
				g.Expect(err).To(HaveOccurred(), "Deployment should be garbage collected")
			}
			Eventually(verifyDeploymentGone).Should(Succeed())

			By("cleaning up the GatewayClass")
			cmd = exec.Command("kubectl", "delete", "gatewayclass", "portail-multi-net")
			_, _ = utils.Run(cmd)
		})
	})
})

// serviceAccountToken returns a token for the specified service account in the given namespace.
// It uses the Kubernetes TokenRequest API to generate a token by directly sending a request
// and parsing the resulting token from the API response.
func serviceAccountToken() (string, error) {
	const tokenRequestRawString = `{
		"apiVersion": "authentication.k8s.io/v1",
		"kind": "TokenRequest"
	}`

	// Temporary file to store the token request
	secretName := fmt.Sprintf("%s-token-request", serviceAccountName)
	tokenRequestFile := filepath.Join("/tmp", secretName)
	err := os.WriteFile(tokenRequestFile, []byte(tokenRequestRawString), os.FileMode(0o644))
	if err != nil {
		return "", err
	}

	var out string
	verifyTokenCreation := func(g Gomega) {
		// Execute kubectl command to create the token
		cmd := exec.Command("kubectl", "create", "--raw", fmt.Sprintf(
			"/api/v1/namespaces/%s/serviceaccounts/%s/token",
			namespace,
			serviceAccountName,
		), "-f", tokenRequestFile)

		output, err := cmd.CombinedOutput()
		g.Expect(err).NotTo(HaveOccurred())

		// Parse the JSON output to extract the token
		var token tokenRequest
		err = json.Unmarshal(output, &token)
		g.Expect(err).NotTo(HaveOccurred())

		out = token.Status.Token
	}
	Eventually(verifyTokenCreation).Should(Succeed())

	return out, err
}

// getMetricsOutput retrieves and returns the logs from the curl pod used to access the metrics endpoint.
func getMetricsOutput() (string, error) {
	By("getting the curl-metrics logs")
	cmd := exec.Command("kubectl", "logs", "curl-metrics", "-n", namespace)
	return utils.Run(cmd)
}

// tokenRequest is a simplified representation of the Kubernetes TokenRequest API response,
// containing only the token field that we need to extract.
type tokenRequest struct {
	Status struct {
		Token string `json:"token"`
	} `json:"status"`
}
