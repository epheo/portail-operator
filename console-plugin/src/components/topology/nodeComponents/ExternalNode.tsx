import { observer } from 'mobx-react';
import {
  DefaultNode,
  GraphElement,
  WithSelectionProps,
  WithDragNodeProps,
} from '@patternfly/react-topology';
import { GlobeIcon } from '@patternfly/react-icons';

type ExternalNodeProps = {
  element: GraphElement;
} & WithSelectionProps &
  WithDragNodeProps;

const ExternalNodeComponent: React.FC<ExternalNodeProps> = ({
  element,
  ...rest
}) => {
  return (
    <DefaultNode
      element={element}
      showStatusDecorator
      statusDecoratorTooltip="External / LoadBalancer entry point"
      badge="LB"
      badgeColor="#0066cc"
      {...rest}
    >
      <g transform={`translate(25, 25)`}>
        <GlobeIcon
          style={{
            fontSize: '24px',
            color: '#0066cc',
          }}
        />
      </g>
    </DefaultNode>
  );
};

export const ExternalNode = observer(ExternalNodeComponent);
