# portail-operator

<img src="logo_icon.png" alt="portail" width="88" align="right"/>

A Kubernetes [Gateway API](https://gateway-api.sigs.k8s.io/) controller that provisions and operates the **portail** data plane. It watches `GatewayClass` and `Gateway` resources and reconciles the workloads that serve their traffic.

## How it works

The operator registers the controller `portail.epheo.eu/gateway-controller` and creates a default `portail` GatewayClass at startup. For every `Gateway` bound to a GatewayClass it owns, it provisions and keeps in sync:

- a **Deployment** running the portail data plane, scoped to that single Gateway
- a **LoadBalancer Service** exposing the Gateway's listener ports
- a per-namespace **ServiceAccount** and a **PodDisruptionBudget**

Cluster-scoped RBAC is reconciled by a singleton controller that maintains one shared `ClusterRoleBinding` across all data-plane ServiceAccounts and prunes orphans. Managed workloads are owned by their Gateway, so deleting a Gateway garbage-collects them.

## Features

- **Gateway API native** — HTTP, HTTPS, TLS, TCP, UDP, and gRPC listeners.
- **Per-Gateway data plane** — each Gateway gets its own isolated deployment.
- **Multi-network** — attach a Gateway to additional cluster networks via the `portail.epheo.eu/Network` address type (Multus CNI).
- **Restricted-PSS compliant** — runs non-root with a read-only root filesystem and all capabilities dropped; privileged listener ports are mapped to unprivileged target ports.
- **OpenShift console plugin** — network topology view with Gateway and route management.

## Getting started

### Prerequisites

- A Kubernetes 1.28+ cluster with the [Gateway API CRDs](https://gateway-api.sigs.k8s.io/guides/#installing-gateway-api) installed.
- `kubectl` with access to the cluster.

### Deploy

```sh
make deploy IMG=<registry>/portail-operator:tag
```

To build and publish the operator image first:

```sh
make image-build image-push IMG=<registry>/portail-operator:tag
```

### Create a Gateway

The `portail` GatewayClass is created automatically. Apply a Gateway that references it:

```sh
kubectl apply -f config/samples/gateway.yaml
```

See `config/samples/` for HTTPS, multi-network, and UDN/TCP examples.

### Uninstall

```sh
make undeploy
```

## Configuration

The manager accepts the following flags, set on the operator Deployment:

| Flag | Default | Description |
|------|---------|-------------|
| `--image` | `ghcr.io/epheo/portail:latest` | Data-plane container image. |
| `--controller-name` | `portail.epheo.eu/gateway-controller` | GatewayClass controller name to match. |
| `--default-replicas` | `2` | Replicas for each managed data-plane Deployment. |
| `--leader-elect` | `false` | Enable leader election for high availability. |
| `--metrics-bind-address` | `0` | Metrics endpoint address (`0` disables it). |

## Console plugin

An OpenShift console plugin under [`console-plugin/`](console-plugin/) adds a network topology view. Build, publish, and deploy it with:

```sh
make console-plugin-image-build console-plugin-image-push CONSOLE_PLUGIN_IMG=<registry>/portail-console-plugin:tag
make console-plugin-deploy
```

## Distribution

Generate a single self-contained manifest:

```sh
make build-installer IMG=<registry>/portail-operator:tag
kubectl apply -f dist/install.yaml
```

Or build an [OLM](https://olm.operatorframework.io/) bundle:

```sh
make bundle bundle-build bundle-push IMG=<registry>/portail-operator:tag
```

## Development

See [CONTRIBUTING.md](CONTRIBUTING.md). Common targets: `make build`, `make test`, `make test-e2e`, `make lint`.

## License

[Apache 2.0](LICENSE).
