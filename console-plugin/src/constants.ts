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

// Node IDs for synthetic nodes
export const EXTERNAL_NODE_ID = '__external__';
export const CLUSTER_DEFAULT_NODE_ID = '__cluster-default__';

// Zone group IDs
export const EXTERNAL_ZONE_ID = '__zone-external__';
export const CLUSTER_ZONE_ID = '__zone-cluster__';
