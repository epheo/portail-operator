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

const RouteNodeComponent: React.FC<RouteNodeProps> = ({
  element,
  ...rest
}) => {
  const data = element.getData() as RouteNodeData;
  const hostLabel = data?.hostnames?.length
    ? data.hostnames[0]
    : '';

  return (
    <DefaultNode
      element={element}
      showStatusDecorator
      statusDecoratorTooltip={`HTTPRoute: ${hostLabel || element.getLabel()}`}
      badge="HTTP"
      badgeColor="#009596"
      {...rest}
    >
      <g transform={`translate(25, 25)`}>
        <RouteIcon
          style={{
            fontSize: '24px',
            color: '#009596',
          }}
        />
      </g>
    </DefaultNode>
  );
};

export const RouteNode = observer(RouteNodeComponent);
