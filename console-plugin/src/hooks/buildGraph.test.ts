import { describe, it, expect } from 'vitest';
import { buildGraph, TopologyResources } from './buildGraph';
import { CONTROLLER_NAME, EXTERNAL_NODE_ID, CLUSTER_DEFAULT_NODE_ID } from '../constants';
import {
  GatewayResource,
  GatewayClassResource,
  HTTPRouteResource,
} from '../types';

const emptyResources = (): TopologyResources => ({
  gateways: [],
  gatewayClasses: [],
  nads: [],
  udns: [],
  httpRoutes: [],
  grpcRoutes: [],
  tcpRoutes: [],
  tlsRoutes: [],
  udpRoutes: [],
});

const managedClass: GatewayClassResource = {
  apiVersion: 'gateway.networking.k8s.io/v1',
  kind: 'GatewayClass',
  metadata: { name: 'portail' },
  spec: { controllerName: CONTROLLER_NAME },
} as GatewayClassResource;

const gateway = (name: string, opts: { className?: string; networks?: string[] } = {}): GatewayResource =>
  ({
    apiVersion: 'gateway.networking.k8s.io/v1',
    kind: 'Gateway',
    metadata: { name, namespace: 'ns1' },
    spec: {
      gatewayClassName: opts.className ?? 'portail',
      listeners: [{ name: 'http', protocol: 'HTTP', port: 80 }],
      addresses: (opts.networks ?? []).map((value) => ({ type: 'portail.epheo.eu/Network', value })),
    },
  }) as GatewayResource;

describe('buildGraph', () => {
  it('always emits the External and cluster-default synthetic nodes and no edges for empty input', () => {
    const { nodes, edges } = buildGraph(emptyResources());
    expect(nodes.map((n) => n.id).sort()).toEqual([CLUSTER_DEFAULT_NODE_ID, EXTERNAL_NODE_ID].sort());
    expect(edges).toHaveLength(0);
  });

  it('wires a LoadBalancer-mode Gateway (no networks) as External -> cluster-default', () => {
    const res = emptyResources();
    res.gatewayClasses = [managedClass];
    res.gateways = [gateway('web')];

    const { edges } = buildGraph(res);
    const gwEdges = edges.filter((e) => e.type === 'gateway');
    expect(gwEdges).toHaveLength(1);
    expect(gwEdges[0].source).toBe(EXTERNAL_NODE_ID);
    expect(gwEdges[0].target).toBe(CLUSTER_DEFAULT_NODE_ID);
  });

  it('ignores Gateways whose GatewayClass is not managed by Portail', () => {
    const res = emptyResources();
    res.gatewayClasses = [
      { ...managedClass, spec: { controllerName: 'someone.else/controller' } } as GatewayClassResource,
    ];
    res.gateways = [gateway('web', { className: 'portail' })];

    const { edges } = buildGraph(res);
    expect(edges.filter((e) => e.type === 'gateway')).toHaveLength(0);
  });

  it('attaches an HTTPRoute to its parent Gateway as a route node and edge', () => {
    const res = emptyResources();
    res.gatewayClasses = [managedClass];
    res.gateways = [gateway('web')];
    res.httpRoutes = [
      {
        apiVersion: 'gateway.networking.k8s.io/v1',
        kind: 'HTTPRoute',
        metadata: { name: 'r1', namespace: 'ns1' },
        spec: { parentRefs: [{ name: 'web' }], rules: [{ backendRefs: [{}] }] },
      } as HTTPRouteResource,
    ];

    const { nodes, edges } = buildGraph(res);
    expect(nodes.some((n) => n.type === 'route' && n.label === 'r1')).toBe(true);
    expect(edges.some((e) => e.type === 'route')).toBe(true);
  });
});
