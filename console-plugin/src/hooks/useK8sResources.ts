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
} from '../constants';
import {
  GatewayResource,
  GatewayClassResource,
  NetworkAttachmentDefinitionResource,
  UserDefinedNetworkResource,
  HTTPRouteResource,
} from '../types';

interface K8sResourcesResult {
  gateways: GatewayResource[];
  gatewayClasses: GatewayClassResource[];
  nads: NetworkAttachmentDefinitionResource[];
  udns: UserDefinedNetworkResource[];
  httpRoutes: HTTPRouteResource[];
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
  }>>(
    () => ({
      gateways: {
        groupVersionKind: GatewayGVK,
        isList: true,
        ...(activeNamespace !== '#ALL_NS#' && { namespace: activeNamespace }),
      },
      gatewayClasses: {
        groupVersionKind: GatewayClassGVK,
        isList: true,
      },
      nads: {
        groupVersionKind: NetworkAttachmentDefinitionGVK,
        isList: true,
        ...(activeNamespace !== '#ALL_NS#' && { namespace: activeNamespace }),
        optional: true,
      },
      udns: {
        groupVersionKind: UserDefinedNetworkGVK,
        isList: true,
        ...(activeNamespace !== '#ALL_NS#' && { namespace: activeNamespace }),
        optional: true,
      },
      httpRoutes: {
        groupVersionKind: HTTPRouteGVK,
        isList: true,
        ...(activeNamespace !== '#ALL_NS#' && { namespace: activeNamespace }),
        optional: true,
      },
    }),
    [activeNamespace],
  );

  const resources = useK8sWatchResources(watchResources);

  const loaded =
    resources.gateways.loaded &&
    resources.gatewayClasses.loaded &&
    (resources.nads.loaded || resources.nads.loadError) &&
    (resources.udns.loaded || resources.udns.loadError) &&
    (resources.httpRoutes.loaded || resources.httpRoutes.loadError);

  const error =
    resources.gateways.loadError || resources.gatewayClasses.loadError || null;

  return {
    gateways: (resources.gateways.data as GatewayResource[]) ?? [],
    gatewayClasses: (resources.gatewayClasses.data as GatewayClassResource[]) ?? [],
    nads: (resources.nads.data as NetworkAttachmentDefinitionResource[]) ?? [],
    udns: (resources.udns.data as UserDefinedNetworkResource[]) ?? [],
    httpRoutes: (resources.httpRoutes.data as HTTPRouteResource[]) ?? [],
    loaded,
    error,
  };
};
