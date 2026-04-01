import {
  DrawerPanelContent,
  DrawerHead,
  DrawerActions,
  DrawerCloseButton,
  Title,
  DescriptionList,
  DescriptionListGroup,
  DescriptionListTerm,
  DescriptionListDescription,
  Label,
  LabelGroup,
} from '@patternfly/react-core';
import { TopologyEdge, GatewayEdgeData } from '../../types';

interface GatewaySidePanelProps {
  edge: TopologyEdge;
  onClose: () => void;
}

function conditionColor(status: string): 'green' | 'orange' | 'red' | 'grey' {
  switch (status) {
    case 'True':
      return 'green';
    case 'False':
      return 'red';
    default:
      return 'grey';
  }
}

export const GatewaySidePanel: React.FC<GatewaySidePanelProps> = ({
  edge,
  onClose,
}) => {
  const data = edge.data as GatewayEdgeData;

  return (
    <DrawerPanelContent isResizable defaultSize="400px" minSize="300px">
      <DrawerHead>
        <Title headingLevel="h2" size="lg">
          {data.gatewayName}
        </Title>
        <DrawerActions>
          <DrawerCloseButton onClick={onClose} />
        </DrawerActions>
      </DrawerHead>
      <div style={{ padding: '0 24px 24px' }}>
        <DescriptionList>
          <DescriptionListGroup>
            <DescriptionListTerm>Namespace</DescriptionListTerm>
            <DescriptionListDescription>{data.gatewayNamespace}</DescriptionListDescription>
          </DescriptionListGroup>

          <DescriptionListGroup>
            <DescriptionListTerm>GatewayClass</DescriptionListTerm>
            <DescriptionListDescription>{data.gatewayClassName}</DescriptionListDescription>
          </DescriptionListGroup>

          <DescriptionListGroup>
            <DescriptionListTerm>Mode</DescriptionListTerm>
            <DescriptionListDescription>
              <Label color={data.mode === 'loadbalancer' ? 'blue' : 'purple'}>
                {data.mode === 'loadbalancer' ? 'North/South (LoadBalancer)' : 'East/West (Multi-Network)'}
              </Label>
            </DescriptionListDescription>
          </DescriptionListGroup>

          <DescriptionListGroup>
            <DescriptionListTerm>Listeners</DescriptionListTerm>
            <DescriptionListDescription>
              {data.listeners.length === 0 ? (
                'None'
              ) : (
                <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                  <thead>
                    <tr>
                      <th style={{ textAlign: 'left', padding: '4px 8px' }}>Name</th>
                      <th style={{ textAlign: 'left', padding: '4px 8px' }}>Protocol</th>
                      <th style={{ textAlign: 'left', padding: '4px 8px' }}>Port</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.listeners.map((l) => (
                      <tr key={l.name}>
                        <td style={{ padding: '4px 8px' }}>{l.name}</td>
                        <td style={{ padding: '4px 8px' }}>{l.protocol}</td>
                        <td style={{ padding: '4px 8px' }}>{l.port}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </DescriptionListDescription>
          </DescriptionListGroup>

          <DescriptionListGroup>
            <DescriptionListTerm>Status</DescriptionListTerm>
            <DescriptionListDescription>
              {data.conditions.length === 0 ? (
                'No conditions'
              ) : (
                <LabelGroup>
                  {data.conditions.map((c) => (
                    <Label key={c.type} color={conditionColor(c.status)}>
                      {c.type}: {c.status}
                      {c.reason ? ` (${c.reason})` : ''}
                    </Label>
                  ))}
                </LabelGroup>
              )}
            </DescriptionListDescription>
          </DescriptionListGroup>

          {data.addresses.length > 0 && (
            <DescriptionListGroup>
              <DescriptionListTerm>Addresses</DescriptionListTerm>
              <DescriptionListDescription>
                {data.addresses.join(', ')}
              </DescriptionListDescription>
            </DescriptionListGroup>
          )}
        </DescriptionList>
      </div>
    </DrawerPanelContent>
  );
};
