import { useMemo } from 'react';
import {
  GraphModel,
  GatewayResource,
  GatewayClassResource,
  NetworkAttachmentDefinitionResource,
  UserDefinedNetworkResource,
  HTTPRouteResource,
  GRPCRouteResource,
  TCPRouteResource,
  TLSRouteResource,
  UDPRouteResource,
} from '../types';
import { buildGraph } from './buildGraph';

export const useTopologyGraph = (
  gateways: GatewayResource[],
  gatewayClasses: GatewayClassResource[],
  nads: NetworkAttachmentDefinitionResource[],
  udns: UserDefinedNetworkResource[],
  httpRoutes: HTTPRouteResource[],
  grpcRoutes: GRPCRouteResource[],
  tcpRoutes: TCPRouteResource[],
  tlsRoutes: TLSRouteResource[],
  udpRoutes: UDPRouteResource[],
): GraphModel => {
  return useMemo(
    () =>
      buildGraph({
        gateways,
        gatewayClasses,
        nads,
        udns,
        httpRoutes,
        grpcRoutes,
        tcpRoutes,
        tlsRoutes,
        udpRoutes,
      }),
    [gateways, gatewayClasses, nads, udns, httpRoutes, grpcRoutes, tcpRoutes, tlsRoutes, udpRoutes],
  );
};
