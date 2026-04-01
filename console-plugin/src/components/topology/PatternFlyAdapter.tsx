import { Model, NodeModel, EdgeModel, NodeShape, EdgeStyle } from '@patternfly/react-topology';
import {
  GraphModel,
  TopologyNode,
  TopologyEdge,
  GatewayEdgeData,
} from '../../types';
import {
  EXTERNAL_ZONE_ID,
  CLUSTER_ZONE_ID,
} from '../../constants';

const NODE_WIDTH = 75;
const NODE_HEIGHT = 75;
const ROUTE_NODE_SIZE = 50;

function nodeShape(node: TopologyNode): NodeShape {
  if (node.type === 'external') return NodeShape.rect;
  if (node.type === 'route') return NodeShape.rhombus;
  return NodeShape.ellipse;
}

function nodeSize(node: TopologyNode): { width: number; height: number } {
  if (node.type === 'route') return { width: ROUTE_NODE_SIZE, height: ROUTE_NODE_SIZE };
  return { width: NODE_WIDTH, height: NODE_HEIGHT };
}

// Build a position map that spreads nodes into readable initial positions.
// Connected cluster nodes are placed side-by-side horizontally so gateway edges are visible.
function computePositions(graph: GraphModel): Map<string, { x: number; y: number }> {
  const positions = new Map<string, { x: number; y: number }>();

  const ZONE_X_EXTERNAL = 100;
  const ZONE_X_CLUSTER = 400;
  const CLUSTER_X_SPACING = 200;
  const Y_SPACING = 140;
  const Y_OFFSET = 50;
  const ROUTE_X_OFFSET = 350;

  // Find which cluster nodes are connected to each other (E/W edges)
  const clusterEdgePairs: Array<[string, string]> = [];
  for (const edge of graph.edges) {
    if (edge.type !== 'gateway') continue;
    const src = graph.nodes.find((n) => n.id === edge.source);
    const tgt = graph.nodes.find((n) => n.id === edge.target);
    if (src?.zone === 'cluster' && tgt?.zone === 'cluster') {
      clusterEdgePairs.push([edge.source, edge.target]);
    }
  }

  // Group connected cluster nodes into rows (pairs sit on the same Y, offset X)
  const placed = new Set<string>();
  let clusterRow = 0;

  // First: place paired nodes side by side
  for (const [srcId, tgtId] of clusterEdgePairs) {
    if (placed.has(srcId) && placed.has(tgtId)) continue;
    const y = Y_OFFSET + clusterRow * Y_SPACING;
    if (!placed.has(srcId)) {
      positions.set(srcId, { x: ZONE_X_CLUSTER, y });
      placed.add(srcId);
    }
    if (!placed.has(tgtId)) {
      positions.set(tgtId, { x: ZONE_X_CLUSTER + CLUSTER_X_SPACING, y });
      placed.add(tgtId);
    }
    clusterRow++;
  }

  // Then: place remaining cluster nodes (not part of E/W pairs) in a column
  for (const node of graph.nodes) {
    if (node.zone !== 'cluster' || node.type === 'route' || placed.has(node.id)) continue;
    positions.set(node.id, { x: ZONE_X_CLUSTER, y: Y_OFFSET + clusterRow * Y_SPACING });
    placed.add(node.id);
    clusterRow++;
  }

  // External nodes
  let extRow = 0;
  for (const node of graph.nodes) {
    if (node.zone !== 'external') continue;
    positions.set(node.id, { x: ZONE_X_EXTERNAL, y: Y_OFFSET + extRow * Y_SPACING });
    extRow++;
  }

  // Route nodes: offset to the right, aligned with their parent gateway's row
  for (const node of graph.nodes) {
    if (node.type !== 'route') continue;
    // Find the edge connecting this route to a gateway node
    const routeEdge = graph.edges.find((e) => e.source === node.id || e.target === node.id);
    const parentId = routeEdge ? (routeEdge.source === node.id ? routeEdge.target : routeEdge.source) : undefined;
    const parentPos = parentId ? positions.get(parentId) : undefined;
    const y = parentPos ? parentPos.y : Y_OFFSET + clusterRow * Y_SPACING;
    positions.set(node.id, { x: ZONE_X_CLUSTER + ROUTE_X_OFFSET, y });
    if (!parentPos) clusterRow++;
  }

  return positions;
}

function nodeToModel(node: TopologyNode, pos: { x: number; y: number }): NodeModel {
  const size = nodeSize(node);
  return {
    id: node.id,
    type: node.type,
    label: node.label,
    width: size.width,
    height: size.height,
    shape: nodeShape(node),
    group: false,
    data: node.data,
    x: pos.x,
    y: pos.y,
  };
}

function gatewayEdgeStyle(data: GatewayEdgeData): EdgeStyle {
  const programmed = data.conditions.find((c) => c.type === 'Programmed');
  const accepted = data.conditions.find((c) => c.type === 'Accepted');

  if (programmed?.status === 'True') return EdgeStyle.solid;
  if (accepted?.status === 'True') return EdgeStyle.dashed;
  return EdgeStyle.dotted;
}

function edgeToModel(edge: TopologyEdge): EdgeModel {
  if (edge.type === 'route') {
    return {
      id: edge.id,
      type: 'route-edge',
      source: edge.source,
      target: edge.target,
      label: edge.label,
      edgeStyle: EdgeStyle.dashed,
      data: edge.data,
    };
  }

  return {
    id: edge.id,
    type: 'gateway',
    source: edge.source,
    target: edge.target,
    label: edge.label,
    edgeStyle: gatewayEdgeStyle(edge.data as GatewayEdgeData),
    data: edge.data,
  };
}

export function createVisualization(graph: GraphModel): Model {
  const externalChildren = graph.nodes
    .filter((n) => n.zone === 'external')
    .map((n) => n.id);

  const clusterChildren = graph.nodes
    .filter((n) => n.zone === 'cluster')
    .map((n) => n.id);

  const groupNodes: NodeModel[] = [
    {
      id: EXTERNAL_ZONE_ID,
      type: 'zone-group',
      label: 'External',
      group: true,
      children: externalChildren,
      style: { padding: 40 },
      data: { zone: 'external' },
    },
    {
      id: CLUSTER_ZONE_ID,
      type: 'zone-group',
      label: 'Cluster Networks',
      group: true,
      children: clusterChildren,
      style: { padding: 40 },
      data: { zone: 'cluster' },
    },
  ];

  return {
    graph: {
      id: 'portail-topology',
      type: 'graph',
      // No auto-layout — we compute positions in computePositions()
    },
    nodes: [...groupNodes, ...(() => {
      const positions = computePositions(graph);
      return graph.nodes.map((n) => nodeToModel(n, positions.get(n.id) ?? { x: 400, y: 50 }));
    })()],
    edges: graph.edges.map(edgeToModel),
  };
}
