import { K8sGroupVersionKind } from '@openshift-console/dynamic-plugin-sdk';

export const CONTROLLER_NAME = 'portail.epheo.eu/gateway-controller';
export const NETWORK_ADDRESS_TYPE = 'portail.epheo.eu/Network';

export const GatewayGVK: K8sGroupVersionKind = {
  group: 'gateway.networking.k8s.io',
  version: 'v1',
  kind: 'Gateway',
};

export const GatewayClassGVK: K8sGroupVersionKind = {
  group: 'gateway.networking.k8s.io',
  version: 'v1',
  kind: 'GatewayClass',
};

export const NetworkAttachmentDefinitionGVK: K8sGroupVersionKind = {
  group: 'k8s.cni.cncf.io',
  version: 'v1',
  kind: 'NetworkAttachmentDefinition',
};

export const UserDefinedNetworkGVK: K8sGroupVersionKind = {
  group: 'k8s.ovn.org',
  version: 'v1',
  kind: 'UserDefinedNetwork',
};

export const HTTPRouteGVK: K8sGroupVersionKind = {
  group: 'gateway.networking.k8s.io',
  version: 'v1',
  kind: 'HTTPRoute',
};

export const GRPCRouteGVK: K8sGroupVersionKind = {
  group: 'gateway.networking.k8s.io',
  version: 'v1',
  kind: 'GRPCRoute',
};

export const TCPRouteGVK: K8sGroupVersionKind = {
  group: 'gateway.networking.k8s.io',
  version: 'v1alpha2',
  kind: 'TCPRoute',
};

export const TLSRouteGVK: K8sGroupVersionKind = {
  group: 'gateway.networking.k8s.io',
  version: 'v1alpha2',
  kind: 'TLSRoute',
};

export const UDPRouteGVK: K8sGroupVersionKind = {
  group: 'gateway.networking.k8s.io',
  version: 'v1alpha2',
  kind: 'UDPRoute',
};

// K8s model for Gateway (used by k8sPatch / k8sDelete)
export const GatewayModel = {
  apiGroup: 'gateway.networking.k8s.io',
  apiVersion: 'v1',
  kind: 'Gateway',
  plural: 'gateways',
  namespaced: true,
  abbr: 'GW',
  label: 'Gateway',
  labelPlural: 'Gateways',
};

// K8s models for Route types (used by k8sCreate / k8sPatch / k8sDelete)
export const HTTPRouteModel = {
  apiGroup: 'gateway.networking.k8s.io',
  apiVersion: 'v1',
  kind: 'HTTPRoute',
  plural: 'httproutes',
  namespaced: true,
  abbr: 'HR',
  label: 'HTTPRoute',
  labelPlural: 'HTTPRoutes',
};

export const GRPCRouteModel = {
  apiGroup: 'gateway.networking.k8s.io',
  apiVersion: 'v1',
  kind: 'GRPCRoute',
  plural: 'grpcroutes',
  namespaced: true,
  abbr: 'GR',
  label: 'GRPCRoute',
  labelPlural: 'GRPCRoutes',
};

export const TCPRouteModel = {
  apiGroup: 'gateway.networking.k8s.io',
  apiVersion: 'v1alpha2',
  kind: 'TCPRoute',
  plural: 'tcproutes',
  namespaced: true,
  abbr: 'TR',
  label: 'TCPRoute',
  labelPlural: 'TCPRoutes',
};

export const TLSRouteModel = {
  apiGroup: 'gateway.networking.k8s.io',
  apiVersion: 'v1alpha2',
  kind: 'TLSRoute',
  plural: 'tlsroutes',
  namespaced: true,
  abbr: 'TLR',
  label: 'TLSRoute',
  labelPlural: 'TLSRoutes',
};

export const UDPRouteModel = {
  apiGroup: 'gateway.networking.k8s.io',
  apiVersion: 'v1alpha2',
  kind: 'UDPRoute',
  plural: 'udproutes',
  namespaced: true,
  abbr: 'UR',
  label: 'UDPRoute',
  labelPlural: 'UDPRoutes',
};

// Helper to get the right model for a route type
export function routeModelForType(routeType: string) {
  switch (routeType) {
    case 'grpc': return GRPCRouteModel;
    case 'tcp': return TCPRouteModel;
    case 'tls': return TLSRouteModel;
    case 'udp': return UDPRouteModel;
    case 'http':
    default: return HTTPRouteModel;
  }
}

// Node IDs for synthetic nodes
export const EXTERNAL_NODE_ID = '__external__';
export const CLUSTER_DEFAULT_NODE_ID = '__cluster-default__';

// Zone group IDs
export const EXTERNAL_ZONE_ID = '__zone-external__';
export const CLUSTER_ZONE_ID = '__zone-cluster__';
