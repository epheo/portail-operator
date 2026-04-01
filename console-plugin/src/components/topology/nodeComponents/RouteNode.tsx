import { observer } from 'mobx-react';
import {
  DefaultNode,
  GraphElement,
  WithSelectionProps,
  WithDragNodeProps,
} from '@patternfly/react-topology';
import { RouteIcon } from '@patternfly/react-icons';
import { RouteNodeData } from '../../../types';

type RouteNodeProps = {
  element: GraphElement;
} & WithSelectionProps &
  WithDragNodeProps;

function routeBadgeConfig(routeType: string): { badge: string; color: string } {
  switch (routeType) {
    case 'grpc':
      return { badge: 'gRPC', color: '#8476D1' };
    case 'tcp':
      return { badge: 'TCP', color: '#C46100' };
    case 'tls':
      return { badge: 'TLS', color: '#EC7A08' };
    case 'udp':
      return { badge: 'UDP', color: '#A18FFF' };
    case 'http':
    default:
      return { badge: 'HTTP', color: '#009596' };
  }
}

const RouteNodeComponent: React.FC<RouteNodeProps> = ({
  element,
  ...rest
}) => {
  const data = element.getData() as RouteNodeData;
  const hostLabel = data?.hostnames?.length
    ? data.hostnames[0]
    : '';
  const { badge, color } = routeBadgeConfig(data?.routeType ?? 'http');

  return (
    <DefaultNode
      element={element}
      showStatusDecorator
      statusDecoratorTooltip={`${badge}Route: ${hostLabel || element.getLabel()}`}
      badge={badge}
      badgeColor={color}
      {...rest}
    >
      <g transform={`translate(25, 25)`}>
        <RouteIcon
          style={{
            fontSize: '24px',
            color,
          }}
        />
      </g>
    </DefaultNode>
  );
};

export const RouteNode = observer(RouteNodeComponent);
