import { observer } from 'mobx-react';
import {
  DefaultNode,
  GraphElement,
  WithSelectionProps,
  WithDragNodeProps,
} from '@patternfly/react-topology';
import { NetworkIcon, ClusterIcon, ShareAltIcon } from '@patternfly/react-icons';
import { NetworkNodeData } from '../../../types';

type NetworkNodeProps = {
  element: GraphElement;
} & WithSelectionProps &
  WithDragNodeProps;

function badgeForType(networkType: NetworkNodeData['networkType']): string {
  switch (networkType) {
    case 'nad':
      return 'NAD';
    case 'udn':
      return 'UDN';
    case 'cluster-default':
      return 'Default';
  }
}

function badgeColorForType(networkType: NetworkNodeData['networkType']): string {
  switch (networkType) {
    case 'nad':
      return '#3e8635'; // green
    case 'udn':
      return '#6753ac'; // purple
    case 'cluster-default':
      return '#0066cc'; // blue
  }
}

function iconForType(networkType: NetworkNodeData['networkType']) {
  switch (networkType) {
    case 'nad':
      return ShareAltIcon;
    case 'udn':
      return NetworkIcon;
    case 'cluster-default':
      return ClusterIcon;
  }
}

const NetworkNodeComponent: React.FC<NetworkNodeProps> = ({
  element,
  ...rest
}) => {
  const data = element.getData() as NetworkNodeData;
  const networkType = data?.networkType ?? 'cluster-default';
  const Icon = iconForType(networkType);

  return (
    <DefaultNode
      element={element}
      showStatusDecorator
      statusDecoratorTooltip={`Network: ${badgeForType(networkType)}`}
      badge={badgeForType(networkType)}
      badgeColor={badgeColorForType(networkType)}
      {...rest}
    >
      <g transform={`translate(25, 25)`}>
        <Icon
          style={{
            fontSize: '24px',
            color: badgeColorForType(networkType),
          }}
        />
      </g>
    </DefaultNode>
  );
};

export const NetworkNode = observer(NetworkNodeComponent);
