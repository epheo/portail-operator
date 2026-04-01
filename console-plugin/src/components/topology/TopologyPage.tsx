import { useState } from 'react';
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
import { TopologyView } from './TopologyView';
import { TopologyToolbar } from './TopologyToolbar';
import { TopologyLegend } from './TopologyLegend';
import { CreateGatewayModal } from '../creation/CreateGatewayModal';
import { useK8sResources } from '../../hooks/useK8sResources';
import { useTopologyGraph } from '../../hooks/useTopologyGraph';
import './TopologyPage.css';

const TopologyPage: React.FC = () => {
  const { gateways, gatewayClasses, nads, udns, httpRoutes, loaded, error } = useK8sResources();
  const graph = useTopologyGraph(gateways, gatewayClasses, nads, udns, httpRoutes);
  const [isModalOpen, setIsModalOpen] = useState(false);

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
      <div className="portail-page-header">
        <Title headingLevel="h1">Portail Network Topology</Title>
        <p className="portail-page-subtitle">
          Visualize Gateway API resources managed by the Portail controller
        </p>
      </div>

      <TopologyToolbar onCreateGateway={() => setIsModalOpen(true)} />

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
                <Button variant="primary" onClick={() => setIsModalOpen(true)}>
                  Create Gateway
                </Button>
              </EmptyStateActions>
            </EmptyStateFooter>
          </EmptyState>
        </div>
      ) : (
        <>
          <div className="portail-topology-surface">
            <TopologyView graph={graph} />
          </div>
          <TopologyLegend />
        </>
      )}

      <CreateGatewayModal
        isOpen={isModalOpen}
        onClose={() => setIsModalOpen(false)}
        gatewayClasses={gatewayClasses}
        availableNetworks={graph.nodes}
      />
    </div>
  );
};

export default TopologyPage;
