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
} from '@patternfly/react-core';
import { TopologyNode, NetworkNodeData } from '../../types';

interface NetworkSidePanelProps {
  node: TopologyNode;
  onClose: () => void;
}

function networkTypeLabel(type: string): string {
  switch (type) {
    case 'nad':
      return 'NetworkAttachmentDefinition (Multus)';
    case 'udn':
      return 'UserDefinedNetwork (OVN-K)';
    case 'cluster-default':
      return 'Cluster Default Network';
    default:
      return type;
  }
}

export const NetworkSidePanel: React.FC<NetworkSidePanelProps> = ({
  node,
  onClose,
}) => {
  const data = node.data as NetworkNodeData;

  return (
    <DrawerPanelContent isResizable defaultSize="400px" minSize="300px">
      <DrawerHead>
        <Title headingLevel="h2" size="lg">
          {node.label}
        </Title>
        <DrawerActions>
          <DrawerCloseButton onClick={onClose} />
        </DrawerActions>
      </DrawerHead>
      <div style={{ padding: '0 24px 24px' }}>
        <DescriptionList>
          <DescriptionListGroup>
            <DescriptionListTerm>Type</DescriptionListTerm>
            <DescriptionListDescription>
              {networkTypeLabel(data.networkType)}
            </DescriptionListDescription>
          </DescriptionListGroup>

          {data.namespace && (
            <DescriptionListGroup>
              <DescriptionListTerm>Namespace</DescriptionListTerm>
              <DescriptionListDescription>{data.namespace}</DescriptionListDescription>
            </DescriptionListGroup>
          )}

          {data.cidr && (
            <DescriptionListGroup>
              <DescriptionListTerm>CIDR</DescriptionListTerm>
              <DescriptionListDescription>{data.cidr}</DescriptionListDescription>
            </DescriptionListGroup>
          )}

          <DescriptionListGroup>
            <DescriptionListTerm>Zone</DescriptionListTerm>
            <DescriptionListDescription>
              {node.zone === 'external' ? 'External (North/South)' : 'Cluster Networks (East/West)'}
            </DescriptionListDescription>
          </DescriptionListGroup>
        </DescriptionList>
      </div>
    </DrawerPanelContent>
  );
};
