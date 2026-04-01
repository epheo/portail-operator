import React, { useCallback, useEffect, useState } from 'react';
import {
  TopologyView as PFTopologyView,
  VisualizationProvider,
  VisualizationSurface,
  useVisualizationController,
  Visualization,
  SELECTION_EVENT,
  TopologyControlBar,
  TopologySideBar,
  createTopologyControlButtons,
  defaultControlButtonsOptions,
  action,
} from '@patternfly/react-topology';
import {
  Title,
  DescriptionList,
  DescriptionListGroup,
  DescriptionListTerm,
  DescriptionListDescription,
  Label,
  LabelGroup,
  Button,
  Alert,
  Divider,
  Modal,
  ModalBody,
  ModalFooter,
  ModalHeader,
  ModalVariant,
  TextInput,
  FormGroup,
  FormSelect,
  FormSelectOption,
} from '@patternfly/react-core';
import { ExternalLinkAltIcon, PlusCircleIcon, TrashIcon, PencilAltIcon, CheckIcon, TimesIcon } from '@patternfly/react-icons';
import { k8sPatch, k8sDelete } from '@openshift-console/dynamic-plugin-sdk';
import {
  GraphModel,
  TopologyNode,
  TopologyEdge,
  GatewayEdgeData,
  NetworkNodeData,
  RouteNodeData,
  ListenerInfo,
} from '../../types';
import { GatewayModel } from '../../constants';
import { createVisualization } from './PatternFlyAdapter';
import { componentFactory } from './componentFactory';
import { layoutFactory } from './layoutFactory';

interface TopologyViewProps {
  graph: GraphModel;
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

const PROTOCOLS = ['HTTP', 'HTTPS', 'TCP', 'TLS', 'UDP', 'GRPC'];

// --- Gateway Panel with editing ---

const GatewayPanelContent: React.FC<{ edge: TopologyEdge }> = ({ edge }) => {
  const data = edge.data as GatewayEdgeData;
  const [editingIndex, setEditingIndex] = useState<number | null>(null);
  const [editListener, setEditListener] = useState<ListenerInfo>({ name: '', protocol: 'HTTP', port: 80 });
  const [showAddListener, setShowAddListener] = useState(false);
  const [newListener, setNewListener] = useState<ListenerInfo>({ name: '', protocol: 'HTTP', port: 80 });
  const [patchError, setPatchError] = useState<string | null>(null);
  const [patching, setPatching] = useState(false);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  const yamlUrl = `/k8s/ns/${data.gatewayNamespace}/gateway.networking.k8s.io~v1~Gateway/${data.gatewayName}/yaml`;
  const resourceUrl = `/k8s/ns/${data.gatewayNamespace}/gateway.networking.k8s.io~v1~Gateway/${data.gatewayName}`;

  const patchListeners = async (updatedListeners: Array<{ name: string; protocol: string; port: number }>) => {
    setPatching(true);
    setPatchError(null);
    try {
      await k8sPatch({
        model: GatewayModel,
        resource: data.resource,
        data: [{ op: 'replace', path: '/spec/listeners', value: updatedListeners }],
      });
      return true;
    } catch (err) {
      setPatchError(String(err));
      return false;
    } finally {
      setPatching(false);
    }
  };

  const startEdit = (index: number) => {
    const l = data.listeners[index];
    setEditListener({ name: l.name, protocol: l.protocol, port: l.port });
    setEditingIndex(index);
    setPatchError(null);
  };

  const cancelEdit = () => {
    setEditingIndex(null);
    setPatchError(null);
  };

  const saveEdit = async () => {
    if (!editListener.name.trim()) {
      setPatchError('Listener name is required');
      return;
    }
    const updated = data.listeners.map((l, i) =>
      i === editingIndex
        ? { name: editListener.name.trim(), protocol: editListener.protocol, port: editListener.port }
        : { name: l.name, protocol: l.protocol, port: l.port },
    );
    if (await patchListeners(updated)) {
      setEditingIndex(null);
    }
  };

  const removeListener = async (index: number) => {
    const updated = data.listeners
      .filter((_, i) => i !== index)
      .map((l) => ({ name: l.name, protocol: l.protocol, port: l.port }));
    await patchListeners(updated);
  };

  const addListener = async () => {
    if (!newListener.name.trim()) {
      setPatchError('Listener name is required');
      return;
    }
    const updated = [
      ...data.listeners.map((l) => ({ name: l.name, protocol: l.protocol, port: l.port })),
      { name: newListener.name.trim(), protocol: newListener.protocol, port: newListener.port },
    ];
    if (await patchListeners(updated)) {
      setShowAddListener(false);
      setNewListener({ name: '', protocol: 'HTTP', port: 80 });
    }
  };

  const handleDeleteGateway = async () => {
    setDeleting(true);
    setDeleteError(null);
    try {
      await k8sDelete({ model: GatewayModel, resource: data.resource });
      setShowDeleteConfirm(false);
    } catch (err) {
      setDeleteError(String(err));
    } finally {
      setDeleting(false);
    }
  };

  const listenerFormRow = (
    listener: ListenerInfo,
    onChange: (l: ListenerInfo) => void,
    prefix: string,
  ) => (
    <div style={{ display: 'flex', gap: '6px', alignItems: 'flex-end', flexWrap: 'wrap' }}>
      <FormGroup label="Name" fieldId={`${prefix}-name`} style={{ flex: '1 1 100px' }}>
        <TextInput id={`${prefix}-name`} value={listener.name} onChange={(_e, v) => onChange({ ...listener, name: v })} />
      </FormGroup>
      <FormGroup label="Protocol" fieldId={`${prefix}-proto`} style={{ flex: '1 1 90px' }}>
        <FormSelect id={`${prefix}-proto`} value={listener.protocol} onChange={(_e, v) => onChange({ ...listener, protocol: v })}>
          {PROTOCOLS.map((p) => <FormSelectOption key={p} value={p} label={p} />)}
        </FormSelect>
      </FormGroup>
      <FormGroup label="Port" fieldId={`${prefix}-port`} style={{ flex: '0 0 80px' }}>
        <TextInput id={`${prefix}-port`} type="number" value={listener.port} onChange={(_e, v) => onChange({ ...listener, port: parseInt(v, 10) || 0 })} />
      </FormGroup>
    </div>
  );

  return (
    <div style={{ padding: '16px' }}>
      <DescriptionList>
        <DescriptionListGroup>
          <DescriptionListTerm>Namespace</DescriptionListTerm>
          <DescriptionListDescription>
            <a href={`/k8s/cluster/namespaces/${data.gatewayNamespace}`}>{data.gatewayNamespace}</a>
          </DescriptionListDescription>
        </DescriptionListGroup>
        <DescriptionListGroup>
          <DescriptionListTerm>GatewayClass</DescriptionListTerm>
          <DescriptionListDescription>
            <a href={`/k8s/cluster/gateway.networking.k8s.io~v1~GatewayClass/${data.gatewayClassName}`}>{data.gatewayClassName}</a>
          </DescriptionListDescription>
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
            {patchError && <Alert variant="danger" title={patchError} isInline isPlain style={{ marginBottom: '8px' }} />}

            {data.listeners.length === 0 && !showAddListener && (
              <span style={{ fontStyle: 'italic', color: 'var(--pf-v6-global--Color--200)' }}>No listeners</span>
            )}

            {data.listeners.map((l, i) => (
              <div key={l.name} style={{
                padding: '8px',
                marginBottom: '4px',
                borderRadius: '4px',
                border: '1px solid var(--pf-v6-global--BorderColor--100, #d2d2d2)',
                background: editingIndex === i ? 'var(--pf-v6-global--BackgroundColor--200, #f0f0f0)' : 'transparent',
              }}>
                {editingIndex === i ? (
                  <>
                    {listenerFormRow(editListener, setEditListener, `edit-${i}`)}
                    <div style={{ display: 'flex', gap: '4px', marginTop: '8px' }}>
                      <Button variant="plain" size="sm" onClick={saveEdit} isDisabled={patching} aria-label="Save">
                        <CheckIcon color="var(--pf-v6-global--success-color--100, #3e8635)" />
                      </Button>
                      <Button variant="plain" size="sm" onClick={cancelEdit} aria-label="Cancel">
                        <TimesIcon />
                      </Button>
                    </div>
                  </>
                ) : (
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                    <span>
                      <strong>{l.name}</strong>
                      <span style={{ margin: '0 6px', color: 'var(--pf-v6-global--Color--200)' }}>|</span>
                      {l.protocol}/{l.port}
                    </span>
                    <span style={{ display: 'flex', gap: '2px' }}>
                      <Button variant="plain" size="sm" onClick={() => startEdit(i)} aria-label="Edit listener" isDisabled={patching}>
                        <PencilAltIcon />
                      </Button>
                      <Button variant="plain" size="sm" onClick={() => removeListener(i)} aria-label="Remove listener" isDisabled={patching || data.listeners.length <= 1}>
                        <TrashIcon color={data.listeners.length <= 1 ? undefined : 'var(--pf-v6-global--danger-color--100, #c9190b)'} />
                      </Button>
                    </span>
                  </div>
                )}
              </div>
            ))}

            {showAddListener ? (
              <div style={{ marginTop: '8px', padding: '8px', borderRadius: '4px', border: '1px dashed var(--pf-v6-global--BorderColor--100, #d2d2d2)' }}>
                {listenerFormRow(newListener, setNewListener, 'add')}
                <div style={{ display: 'flex', gap: '8px', marginTop: '8px' }}>
                  <Button variant="primary" size="sm" onClick={addListener} isDisabled={patching} isLoading={patching}>Add</Button>
                  <Button variant="link" size="sm" onClick={() => { setShowAddListener(false); setPatchError(null); }}>Cancel</Button>
                </div>
              </div>
            ) : (
              <Button variant="link" icon={<PlusCircleIcon />} onClick={() => { setShowAddListener(true); setEditingIndex(null); setPatchError(null); }} style={{ marginTop: '4px' }}>
                Add listener
              </Button>
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

      <Divider style={{ margin: '16px 0' }} />

      <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
        <Button variant="secondary" icon={<ExternalLinkAltIcon />} component="a" href={resourceUrl}>
          View Resource
        </Button>
        <Button variant="secondary" component="a" href={yamlUrl}>
          YAML
        </Button>
        <Button variant="danger" icon={<TrashIcon />} onClick={() => setShowDeleteConfirm(true)}>
          Delete
        </Button>
      </div>

      <Modal variant={ModalVariant.small} isOpen={showDeleteConfirm} onClose={() => setShowDeleteConfirm(false)}>
        <ModalHeader title={`Delete Gateway "${data.gatewayName}"?`} />
        <ModalBody>
          {deleteError && <Alert variant="danger" title={deleteError} isInline style={{ marginBottom: '8px' }} />}
          This will permanently delete the Gateway <strong>{data.gatewayName}</strong> from namespace <strong>{data.gatewayNamespace}</strong>.
          This action cannot be undone.
        </ModalBody>
        <ModalFooter>
          <Button variant="danger" onClick={handleDeleteGateway} isDisabled={deleting} isLoading={deleting}>Delete</Button>
          <Button variant="link" onClick={() => setShowDeleteConfirm(false)}>Cancel</Button>
        </ModalFooter>
      </Modal>
    </div>
  );
};

// --- Network Panel ---

const NetworkPanelContent: React.FC<{ node: TopologyNode }> = ({ node }) => {
  const data = node.data as NetworkNodeData;
  return (
    <div style={{ padding: '16px' }}>
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
  );
};

// --- Route Panel ---

const RoutePanelContent: React.FC<{ node: TopologyNode }> = ({ node }) => {
  const data = node.data as RouteNodeData;
  const route = data.resource as import('../../types').HTTPRouteResource;
  const rules = route.spec.rules ?? [];
  const parentStatus = route.status?.parents ?? [];

  return (
    <div style={{ padding: '16px' }}>
      <DescriptionList>
        <DescriptionListGroup>
          <DescriptionListTerm>Type</DescriptionListTerm>
          <DescriptionListDescription>
            <Label color="teal" isCompact>HTTPRoute</Label>
          </DescriptionListDescription>
        </DescriptionListGroup>
        {data.namespace && (
          <DescriptionListGroup>
            <DescriptionListTerm>Namespace</DescriptionListTerm>
            <DescriptionListDescription>{data.namespace}</DescriptionListDescription>
          </DescriptionListGroup>
        )}
        <DescriptionListGroup>
          <DescriptionListTerm>Hostnames</DescriptionListTerm>
          <DescriptionListDescription>
            {data.hostnames.length > 0 ? (
              <LabelGroup>
                {data.hostnames.map((h) => (
                  <Label key={h} isCompact>{h}</Label>
                ))}
              </LabelGroup>
            ) : (
              <span style={{ fontStyle: 'italic' }}>Any (no hostname filter)</span>
            )}
          </DescriptionListDescription>
        </DescriptionListGroup>
        <DescriptionListGroup>
          <DescriptionListTerm>Rules ({rules.length})</DescriptionListTerm>
          <DescriptionListDescription>
            {rules.length === 0 ? (
              'No rules'
            ) : (
              <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                <thead>
                  <tr>
                    <th style={{ textAlign: 'left', padding: '4px 8px' }}>Match</th>
                    <th style={{ textAlign: 'left', padding: '4px 8px' }}>Backends</th>
                  </tr>
                </thead>
                <tbody>
                  {rules.map((rule, i) => {
                    const matchStr = rule.matches?.map((m) =>
                      m.path ? `${m.path.type ?? 'PathPrefix'}:${m.path.value ?? '/'}` : '*',
                    ).join(', ') ?? '*';
                    const backendStr = rule.backendRefs?.map((b) =>
                      `${b.name}${b.port ? ':' + b.port : ''}`,
                    ).join(', ') ?? 'none';
                    return (
                      <tr key={i}>
                        <td style={{ padding: '4px 8px', fontFamily: 'monospace', fontSize: '0.85em' }}>{matchStr}</td>
                        <td style={{ padding: '4px 8px', fontFamily: 'monospace', fontSize: '0.85em' }}>{backendStr}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
          </DescriptionListDescription>
        </DescriptionListGroup>
        {parentStatus.length > 0 && (
          <DescriptionListGroup>
            <DescriptionListTerm>Parent Status</DescriptionListTerm>
            <DescriptionListDescription>
              {parentStatus.map((ps, i) => (
                <div key={i} style={{ marginBottom: '4px' }}>
                  <strong>{ps.parentRef.name}</strong>
                  {ps.conditions && (
                    <LabelGroup style={{ marginTop: '4px' }}>
                      {ps.conditions.map((c) => (
                        <Label key={c.type} color={conditionColor(c.status)} isCompact>
                          {c.type}: {c.status}
                        </Label>
                      ))}
                    </LabelGroup>
                  )}
                </div>
              ))}
            </DescriptionListDescription>
          </DescriptionListGroup>
        )}
      </DescriptionList>
    </div>
  );
};

// --- Main Topology Content ---

const TopologyContent: React.FC<TopologyViewProps> = ({ graph }) => {
  const controller = useVisualizationController();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [selectedType, setSelectedType] = useState<'network' | 'external' | 'gateway' | 'route' | null>(null);

  const isFirstRender = React.useRef(true);
  const prevNodeIds = React.useRef('');
  const prevEdgeIds = React.useRef('');

  useEffect(() => {
    const nodeIds = graph.nodes.map((n) => n.id).sort().join(',');
    const edgeIds = graph.edges.map((e) => e.id).sort().join(',');
    const structureChanged = nodeIds !== prevNodeIds.current || edgeIds !== prevEdgeIds.current;
    prevNodeIds.current = nodeIds;
    prevEdgeIds.current = edgeIds;

    // Always use our computed positions — no Cola auto-layout
    const model = createVisualization(graph);
    controller.fromModel(model);

    // Fit to screen on first render or when topology structure changes
    if (isFirstRender.current || structureChanged) {
      isFirstRender.current = false;
      const timer = setTimeout(() => {
        try { controller.getGraph().fit(80); } catch { /* not ready */ }
      }, 50);
      return () => clearTimeout(timer);
    }
  }, [graph, controller]);

  useEffect(() => {
    const onSelect = (ids: string[]) => {
      if (ids.length === 0) {
        setSelectedId(null);
        setSelectedType(null);
        return;
      }
      const id = ids[0];
      const node = graph.nodes.find((n) => n.id === id);
      if (node) {
        setSelectedType(node.type as 'network' | 'external' | 'route');
        setSelectedId(id);
        return;
      }
      const edge = graph.edges.find((e) => e.id === id);
      if (edge) {
        setSelectedType('gateway');
        setSelectedId(id);
      }
    };

    controller.addEventListener(SELECTION_EVENT, onSelect);
    return () => { controller.removeEventListener(SELECTION_EVENT, onSelect); };
  }, [controller, graph]);

  // Clear selection when the selected item is removed from the graph (e.g. after delete)
  useEffect(() => {
    if (!selectedId) return;
    const nodeExists = graph.nodes.some((n) => n.id === selectedId);
    const edgeExists = graph.edges.some((e) => e.id === selectedId);
    if (!nodeExists && !edgeExists) {
      setSelectedId(null);
      setSelectedType(null);
    }
  }, [graph, selectedId]);

  const onClosePanel = useCallback(() => {
    setSelectedId(null);
    setSelectedType(null);
  }, []);

  // Build sidebar header and content
  let panelTitle = '';
  let panelContent: React.ReactNode = null;

  if (selectedId && selectedType === 'gateway') {
    const edge = graph.edges.find((e) => e.id === selectedId);
    if (edge) {
      panelTitle = (edge.data as GatewayEdgeData).gatewayName;
      panelContent = <GatewayPanelContent edge={edge} />;
    }
  } else if (selectedId && selectedType === 'route') {
    const node = graph.nodes.find((n) => n.id === selectedId);
    if (node) {
      panelTitle = node.label;
      panelContent = <RoutePanelContent node={node} />;
    }
  } else if (selectedId && (selectedType === 'network' || selectedType === 'external')) {
    const node = graph.nodes.find((n) => n.id === selectedId);
    if (node) {
      panelTitle = node.label;
      panelContent = <NetworkPanelContent node={node} />;
    }
  }

  const sideBar = (
    <TopologySideBar
      show={!!selectedId && !!panelContent}
      onClose={onClosePanel}
    >
      <div style={{ padding: '16px' }}>
        <Title headingLevel="h2" size="lg" style={{ marginBottom: '16px' }}>{panelTitle}</Title>
        {panelContent}
      </div>
    </TopologySideBar>
  );

  const controlBar = (
    <TopologyControlBar
      controlButtons={createTopologyControlButtons({
        ...defaultControlButtonsOptions,
        zoomInCallback: action(() => {
          controller.getGraph().scaleBy(4 / 3);
        }),
        zoomOutCallback: action(() => {
          controller.getGraph().scaleBy(3 / 4);
        }),
        fitToScreenCallback: action(() => {
          controller.getGraph().fit(80);
        }),
        resetViewCallback: action(() => {
          const model = createVisualization(graph);
          controller.fromModel(model);
          controller.getGraph().fit(80);
        }),
        legend: false,
      })}
    />
  );

  return (
    <PFTopologyView
      sideBar={sideBar}
      controlBar={controlBar}
    >
      <VisualizationSurface />
    </PFTopologyView>
  );
};

export const TopologyView: React.FC<TopologyViewProps> = ({ graph }) => {
  const [visualization] = useState(() => {
    const vis = new Visualization();
    vis.registerComponentFactory(componentFactory);
    vis.registerLayoutFactory(layoutFactory);
    return vis;
  });

  return (
    <VisualizationProvider controller={visualization}>
      <TopologyContent graph={graph} />
    </VisualizationProvider>
  );
};
