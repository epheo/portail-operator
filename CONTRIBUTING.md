# Contributing to portail-operator

Contributions are welcome. This guide covers the basics.

## Prerequisites

- Go 1.25.0+
- Podman 4.0+
- kubectl 1.28.0+
- Access to a Kubernetes 1.28.0+ cluster (or kind for local development)

## Building

```sh
make build
```

## Running Tests

Unit tests:

```sh
make test
```

End-to-end tests (requires a kind cluster):

```sh
make test-e2e
```

## Linting

```sh
make lint
```

## Submitting Changes

1. Fork the repository
2. Create a feature branch from `main`
3. Make your changes
4. Run `make lint test` to verify
5. Run `make manifests` if you changed RBAC markers or API types
6. Open a pull request against `main`

## Code Style

- Follow existing patterns in the codebase
- Use structured logging via controller-runtime's `log` package
- Keep controllers focused on a single resource type
