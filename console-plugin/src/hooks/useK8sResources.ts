import { useMemo } from 'react';
import {
  useK8sWatchResources,
  useActiveNamespace,
  WatchK8sResources,
} from '@openshift-console/dynamic-plugin-sdk';
import {
  GatewayGVK,
  GatewayClassGVK,
  NetworkAttachmentDefinitionGVK,
  UserDefinedNetworkGVK,
  HTTPRouteGVK,
  GRPCRouteGVK,
  TCPRouteGVK,
  TLSRouteGVK,
  UDPRouteGVK,
} from '../constants';
import { K8sResourceCommon } from '@openshift-console/dynamic-plugin-sdk';
import {
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

const ServiceGVK = { group: '', version: 'v1', kind: 'Service' };

interface K8sResourcesResult {
  gateways: GatewayResource[];
  gatewayClasses: GatewayClassResource[];
  nads: NetworkAttachmentDefinitionResource[];
  udns: UserDefinedNetworkResource[];
  httpRoutes: HTTPRouteResource[];
  grpcRoutes: GRPCRouteResource[];
  tcpRoutes: TCPRouteResource[];
  tlsRoutes: TLSRouteResource[];
  udpRoutes: UDPRouteResource[];
  services: K8sResourceCommon[];
  loaded: boolean;
  error: unknown;
}

export const useK8sResources = (): K8sResourcesResult => {
  const [activeNamespace] = useActiveNamespace();

  const watchResources = useMemo<WatchK8sResources<{
    gateways: GatewayResource[];
    gatewayClasses: GatewayClassResource[];
    nads: NetworkAttachmentDefinitionResource[];
    udns: UserDefinedNetworkResource[];
    httpRoutes: HTTPRouteResource[];
    grpcRoutes: GRPCRouteResource[];
    tcpRoutes: TCPRouteResource[];
    tlsRoutes: TLSRouteResource[];
    udpRoutes: UDPRouteResource[];
    services: K8sResourceCommon[];
  }>>(
    () => {
      const nsFilter = activeNamespace !== '#ALL_NS#' ? { namespace: activeNamespace } : {};
      return {
        gateways: {
          groupVersionKind: GatewayGVK,
          isList: true,
          ...nsFilter,
        },
        gatewayClasses: {
          groupVersionKind: GatewayClassGVK,
          isList: true,
        },
        nads: {
          groupVersionKind: NetworkAttachmentDefinitionGVK,
          isList: true,
          ...nsFilter,
          optional: true,
        },
        udns: {
          groupVersionKind: UserDefinedNetworkGVK,
          isList: true,
          ...nsFilter,
          optional: true,
        },
        httpRoutes: {
          groupVersionKind: HTTPRouteGVK,
          isList: true,
          ...nsFilter,
          optional: true,
        },
        grpcRoutes: {
          groupVersionKind: GRPCRouteGVK,
          isList: true,
          ...nsFilter,
          optional: true,
        },
        tcpRoutes: {
          groupVersionKind: TCPRouteGVK,
          isList: true,
          ...nsFilter,
          optional: true,
        },
        tlsRoutes: {
          groupVersionKind: TLSRouteGVK,
          isList: true,
          ...nsFilter,
          optional: true,
        },
        udpRoutes: {
          groupVersionKind: UDPRouteGVK,
          isList: true,
          ...nsFilter,
          optional: true,
        },
        services: {
          groupVersionKind: ServiceGVK,
          isList: true,
          ...nsFilter,
        },
      };
    },
    [activeNamespace],
  );

  const resources = useK8sWatchResources(watchResources);

  const optionalLoaded = (r: { loaded: boolean; loadError?: unknown }) =>
    r.loaded || !!r.loadError;

  const loaded =
    resources.gateways.loaded &&
    resources.gatewayClasses.loaded &&
    resources.services.loaded &&
    optionalLoaded(resources.nads) &&
    optionalLoaded(resources.udns) &&
    optionalLoaded(resources.httpRoutes) &&
    optionalLoaded(resources.grpcRoutes) &&
    optionalLoaded(resources.tcpRoutes) &&
    optionalLoaded(resources.tlsRoutes) &&
    optionalLoaded(resources.udpRoutes);

  const error =
    resources.gateways.loadError || resources.gatewayClasses.loadError || null;

  return {
    gateways: (resources.gateways.data as GatewayResource[]) ?? [],
    gatewayClasses: (resources.gatewayClasses.data as GatewayClassResource[]) ?? [],
    nads: (resources.nads.data as NetworkAttachmentDefinitionResource[]) ?? [],
    udns: (resources.udns.data as UserDefinedNetworkResource[]) ?? [],
    httpRoutes: (resources.httpRoutes.data as HTTPRouteResource[]) ?? [],
    grpcRoutes: (resources.grpcRoutes.data as GRPCRouteResource[]) ?? [],
    tcpRoutes: (resources.tcpRoutes.data as TCPRouteResource[]) ?? [],
    tlsRoutes: (resources.tlsRoutes.data as TLSRouteResource[]) ?? [],
    udpRoutes: (resources.udpRoutes.data as UDPRouteResource[]) ?? [],
    services: (resources.services.data as K8sResourceCommon[]) ?? [],
    loaded,
    error,
  };
};
