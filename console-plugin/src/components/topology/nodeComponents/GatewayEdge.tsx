import { observer } from 'mobx-react';
import {
  DefaultEdge,
  GraphElement,
  WithSelectionProps,
  EdgeTerminalType,
} from '@patternfly/react-topology';
import { GatewayEdgeData } from '../../../types';

type GatewayEdgeProps = {
  element: GraphElement;
} & WithSelectionProps;

function tagForListeners(data: GatewayEdgeData): string {
  if (data.listeners.length === 0) return '';
  return data.listeners
    .map((l) => `${l.protocol}/${l.port}`)
    .join(', ');
}

function edgeStatusClass(data: GatewayEdgeData): string {
  const programmed = data.conditions.find((c) => c.type === 'Programmed');
  const accepted = data.conditions.find((c) => c.type === 'Accepted');

  if (programmed?.status === 'True') return 'portail-edge-programmed';
  if (accepted?.status === 'True') return 'portail-edge-accepted';
  return 'portail-edge-error';
}

const GatewayEdgeComponent: React.FC<GatewayEdgeProps> = ({
  element,
  ...rest
}) => {
  const data = element.getData() as GatewayEdgeData;
  const tag = tagForListeners(data);
  const statusClass = edgeStatusClass(data);

  return (
    <DefaultEdge
      element={element}
      endTerminalType={EdgeTerminalType.directional}
      tag={tag}
      className={statusClass}
      {...rest}
    />
  );
};

export const GatewayEdge = observer(GatewayEdgeComponent);
