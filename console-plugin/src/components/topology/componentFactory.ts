import {
  ComponentFactory,
  ModelKind,
  GraphComponent,
  withSelection,
  withDragNode,
  withPanZoom,
  DefaultEdge,
} from '@patternfly/react-topology';
import { NetworkNode } from './nodeComponents/NetworkNode';
import { ExternalNode } from './nodeComponents/ExternalNode';
import { RouteNode } from './nodeComponents/RouteNode';
import { ZoneGroup } from './nodeComponents/ZoneGroup';
import { GatewayEdge } from './nodeComponents/GatewayEdge';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const componentFactory: ComponentFactory = (kind, type) => {
  switch (type) {
    case 'network':
      return withDragNode()(withSelection()(NetworkNode)) as any; // eslint-disable-line @typescript-eslint/no-explicit-any
    case 'external':
      return withDragNode()(withSelection()(ExternalNode)) as any; // eslint-disable-line @typescript-eslint/no-explicit-any
    case 'route':
      return withDragNode()(withSelection()(RouteNode)) as any; // eslint-disable-line @typescript-eslint/no-explicit-any
    case 'zone-group':
      return ZoneGroup as any; // eslint-disable-line @typescript-eslint/no-explicit-any
    case 'gateway':
      return withSelection()(GatewayEdge) as any; // eslint-disable-line @typescript-eslint/no-explicit-any
    case 'route-edge':
      return DefaultEdge; // eslint-disable-line @typescript-eslint/no-explicit-any
    default:
      switch (kind) {
        case ModelKind.graph:
          return withPanZoom()(GraphComponent);
        default:
          return undefined;
      }
  }
};
