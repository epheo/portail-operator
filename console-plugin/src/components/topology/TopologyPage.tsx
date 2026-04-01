import { useState, useCallback } from 'react';
import {
  Title,
  EmptyState,
  EmptyStateBody,
  EmptyStateActions,
  EmptyStateFooter,
  Spinner,
  Button,
} from '@patternfly/react-core';
import { TopologyIcon } from '@patternfly/react-icons';
import { NamespaceBar } from '@openshift-console/dynamic-plugin-sdk';
import { TopologyView } from './TopologyView';
import { TopologyLegend } from './TopologyLegend';
import { CreateGatewayModal } from '../creation/CreateGatewayModal';
import { CreateRouteModal } from '../creation/CreateRouteModal';
import { useK8sResources } from '../../hooks/useK8sResources';
import { useTopologyGraph } from '../../hooks/useTopologyGraph';
import { useNamespaceSync } from '../../hooks/useNamespaceSync';
import { CONTROLLER_NAME } from '../../constants';
import { GatewayResource } from '../../types';
import './TopologyPage.css';

const TopologyPage: React.FC = () => {
  useNamespaceSync();
  const { gateways, gatewayClasses, nads, udns, httpRoutes, grpcRoutes, tcpRoutes, tlsRoutes, udpRoutes, services, loaded, error } = useK8sResources();
  const serviceNames = services.map((s) => s.metadata?.name).filter(Boolean) as string[];
  const graph = useTopologyGraph(gateways, gatewayClasses, nads, udns, httpRoutes, grpcRoutes, tcpRoutes, tlsRoutes, udpRoutes);
  const [isGatewayModalOpen, setIsGatewayModalOpen] = useState(false);
  const [isRouteModalOpen, setIsRouteModalOpen] = useState(false);
  const [preselectedGateway, setPreselectedGateway] = useState<string | undefined>();

  // Filter gateways managed by Portail
  const managedClassNames = new Set(
    gatewayClasses
      .filter((gc) => gc.spec.controllerName === CONTROLLER_NAME)
      .map((gc) => gc.metadata?.name),
  );
  const managedGateways: GatewayResource[] = gateways.filter(
    (gw) => managedClassNames.has(gw.spec.gatewayClassName),
  );

  const handleAddRoute = useCallback((gatewayName: string) => {
    setPreselectedGateway(gatewayName);
    setIsRouteModalOpen(true);
  }, []);

  const handleOpenRouteModal = useCallback(() => {
    setPreselectedGateway(undefined);
    setIsRouteModalOpen(true);
  }, []);

  if (error) {
    return (
      <div className="portail-topology-page">
        <EmptyState>
          <Title headingLevel="h4" size="lg">
            Error loading resources
          </Title>
          <EmptyStateBody>{String(error)}</EmptyStateBody>
        </EmptyState>
      </div>
    );
  }

  if (!loaded) {
    return (
      <div className="portail-topology-page portail-topology-page--centered">
        <EmptyState>
          <Spinner size="xl" />
          <Title headingLevel="h4" size="lg">
            Loading network topology...
          </Title>
        </EmptyState>
      </div>
    );
  }

  const hasGateways = graph.edges.length > 0;

  return (
    <div className="portail-topology-page">
      <NamespaceBar />

      <div className="portail-page-header">
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <Title headingLevel="h1">Portail Network Topology</Title>
          <Button variant="primary" onClick={() => setIsGatewayModalOpen(true)}>
            Create Gateway
          </Button>
        </div>
        <p className="portail-page-subtitle">
          Visualize Gateway API resources managed by the Portail controller
        </p>
      </div>

      {!hasGateways ? (
        <div className="portail-empty-state">
          <TopologyIcon className="portail-empty-state__icon" />
          <Title headingLevel="h3" size="lg">
            No gateways found
          </Title>
          <EmptyState>
            <EmptyStateBody>
              No Portail-managed Gateway resources exist in the current scope.
              Create a Gateway to connect your networks.
            </EmptyStateBody>
            <EmptyStateFooter>
              <EmptyStateActions>
                <Button variant="primary" onClick={() => setIsGatewayModalOpen(true)}>
                  Create Gateway
                </Button>
              </EmptyStateActions>
            </EmptyStateFooter>
          </EmptyState>
        </div>
      ) : (
        <>
          <div className="portail-topology-surface">
            <TopologyView graph={graph} onAddRoute={handleAddRoute} serviceNames={serviceNames} />
          </div>
          <TopologyLegend />
        </>
      )}

      <CreateGatewayModal
        isOpen={isGatewayModalOpen}
        onClose={() => setIsGatewayModalOpen(false)}
        gatewayClasses={gatewayClasses}
        availableNetworks={graph.nodes}
      />

      <CreateRouteModal
        isOpen={isRouteModalOpen}
        onClose={() => setIsRouteModalOpen(false)}
        managedGateways={managedGateways}
        preselectedGateway={preselectedGateway}
        serviceNames={serviceNames}
      />
    </div>
  );
};

export default TopologyPage;
