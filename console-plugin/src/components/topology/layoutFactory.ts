import {
  Graph,
  Layout,
  LayoutFactory,
  ColaLayout,
  ColaLayoutOptions,
  LayoutOptions,
} from '@patternfly/react-topology';

const layoutOptions: Partial<ColaLayoutOptions & LayoutOptions> = {
  maxTicks: 100,
  initialUnconstrainedIterations: 50,
  initialUserConstraintIterations: 50,
  initialAllConstraintsIterations: 50,
  gridSnapIterations: 50,
  // Spread nodes apart so zones don't overlap
  nodeDistance: 100,
  groupDistance: 80,
  linkDistance: 150,
  collideDistance: 40,
  chargeStrength: -200,
  layoutOnDrag: false,
};

export const layoutFactory: LayoutFactory = (
  type: string,
  graph: Graph,
): Layout | undefined => {
  return new ColaLayout(graph, layoutOptions);
};
