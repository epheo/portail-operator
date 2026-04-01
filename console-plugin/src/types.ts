import { K8sResourceCommon } from '@openshift-console/dynamic-plugin-sdk';

// Graph model — library-agnostic representation of the topology

export type NodeType = 'network' | 'external' | 'route';

export interface NetworkNodeData {
  networkType: 'cluster-default' | 'nad' | 'udn';
  namespace?: string;
  cidr?: string;
  resource?: K8sResourceCommon;
}

export interface RouteNodeData {
  routeType: 'http' | 'grpc' | 'tcp' | 'tls' | 'udp';
  hostnames: string[];
  rulesCount: number;
  backendCount: number;
  parentGatewayEdgeId: string;
  namespace?: string;
  resource: K8sResourceCommon;
}

export interface TopologyNode {
  id: string;
  type: NodeType;
  label: string;
  zone: 'external' | 'cluster';
  data: NetworkNodeData | RouteNodeData;
}

export type GatewayMode = 'loadbalancer' | 'multi-network';

export interface ListenerInfo {
  name: string;
  protocol: string;
  port: number;
  hostname?: string;
}

export interface GatewayCondition {
  type: string;
  status: string;
  reason?: string;
  message?: string;
  lastTransitionTime?: string;
}

export interface GatewayEdgeData {
  mode: GatewayMode;
  gatewayName: string;
  gatewayNamespace: string;
  gatewayClassName: string;
  listeners: ListenerInfo[];
  conditions: GatewayCondition[];
  addresses: string[];
  resource: K8sResourceCommon;
}

export interface TopologyEdge {
  id: string;
  type: 'gateway' | 'route';
  source: string;
  target: string;
  label: string;
  data: GatewayEdgeData | RouteEdgeData;
}

export interface RouteEdgeData {
  routeName: string;
  routeNamespace: string;
  parentGateway: string;
}

export interface GraphModel {
  nodes: TopologyNode[];
  edges: TopologyEdge[];
}

// Kubernetes resource types used by the plugin

export interface GatewayAddress {
  type?: string;
  value: string;
}

export interface GatewayListener {
  name: string;
  hostname?: string;
  port: number;
  protocol: string;
}

export interface GatewayResource extends K8sResourceCommon {
  spec: {
    gatewayClassName: string;
    listeners: GatewayListener[];
    addresses?: GatewayAddress[];
  };
  status?: {
    conditions?: GatewayCondition[];
    addresses?: GatewayAddress[];
  };
}

export interface GatewayClassResource extends K8sResourceCommon {
  spec: {
    controllerName: string;
  };
}

export interface NetworkAttachmentDefinitionResource extends K8sResourceCommon {
  spec?: {
    config?: string;
  };
}

export interface UserDefinedNetworkResource extends K8sResourceCommon {
  spec?: {
    topology?: string;
    layer3?: {
      subnets?: Array<{ cidr: string }>;
    };
    layer2?: {
      subnets?: Array<{ cidr: string }>;
    };
  };
}

export interface HTTPRouteParentRef {
  group?: string;
  kind?: string;
  name: string;
  namespace?: string;
  sectionName?: string;
}

export interface HTTPRouteBackendRef {
  name: string;
  namespace?: string;
  port?: number;
  weight?: number;
}

export interface HTTPRouteRule {
  matches?: Array<{
    path?: { type?: string; value?: string };
    headers?: Array<{ type?: string; name: string; value: string }>;
    method?: string;
  }>;
  backendRefs?: HTTPRouteBackendRef[];
}

export interface HTTPRouteResource extends K8sResourceCommon {
  spec: {
    parentRefs?: HTTPRouteParentRef[];
    hostnames?: string[];
    rules?: HTTPRouteRule[];
  };
  status?: {
    parents?: Array<{
      parentRef: { name: string; namespace?: string };
      conditions?: GatewayCondition[];
    }>;
  };
}

export interface GRPCRouteMethodMatch {
  type?: 'Exact' | 'RegularExpression';
  service?: string;
  method?: string;
}

export interface GRPCRouteRule {
  matches?: Array<{
    method?: GRPCRouteMethodMatch;
    headers?: Array<{ type?: string; name: string; value: string }>;
  }>;
  backendRefs?: HTTPRouteBackendRef[];
}

export interface GRPCRouteResource extends K8sResourceCommon {
  spec: {
    parentRefs?: HTTPRouteParentRef[];
    hostnames?: string[];
    rules?: GRPCRouteRule[];
  };
  status?: {
    parents?: Array<{
      parentRef: { name: string; namespace?: string };
      conditions?: GatewayCondition[];
    }>;
  };
}

export interface TCPRouteRule {
  backendRefs?: HTTPRouteBackendRef[];
}

export interface TCPRouteResource extends K8sResourceCommon {
  spec: {
    parentRefs?: HTTPRouteParentRef[];
    rules?: TCPRouteRule[];
  };
  status?: {
    parents?: Array<{
      parentRef: { name: string; namespace?: string };
      conditions?: GatewayCondition[];
    }>;
  };
}

export interface TLSRouteResource extends K8sResourceCommon {
  spec: {
    parentRefs?: HTTPRouteParentRef[];
    hostnames?: string[];
    rules?: TCPRouteRule[]; // TLSRoute rules have same shape: only backendRefs
  };
  status?: {
    parents?: Array<{
      parentRef: { name: string; namespace?: string };
      conditions?: GatewayCondition[];
    }>;
  };
}

export type UDPRouteResource = TCPRouteResource; // Same shape: parentRefs + rules with backendRefs only

