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
  RouteEdgeData,
  NetworkNodeData,
  RouteNodeData,
  ListenerInfo,
  HTTPRouteResource,
  GRPCRouteResource,
  TCPRouteResource,
  TLSRouteResource,
} from '../../types';
import { GatewayModel, routeModelForType } from '../../constants';
import { createVisualization } from './PatternFlyAdapter';
import { componentFactory } from './componentFactory';
import { layoutFactory } from './layoutFactory';

interface TopologyViewProps {
  graph: GraphModel;
  onAddRoute?: (gatewayName: string) => void;
  serviceNames?: string[];
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

// --- Gateway Routes Section (shown inside gateway panel) ---

const GatewayRoutesSection: React.FC<{
  gatewayName: string;
  gatewayNamespace: string;
  graph: GraphModel;
  serviceNames: string[];
  onAddRoute?: (gatewayName: string) => void;
}> = ({ gatewayName, gatewayNamespace, graph, serviceNames, onAddRoute }) => {
  const [deletingRoute, setDeletingRoute] = useState<string | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  // Find route nodes attached to this gateway
  const attachedRoutes = graph.edges
    .filter((e) => e.type === 'route')
    .filter((e) => {
      const d = e.data as RouteEdgeData;
      return d.parentGateway === gatewayName;
    })
    .map((e) => {
      const node = graph.nodes.find((n) => n.type === 'route' && (n.id === e.source || n.id === e.target));
      if (!node) return null;
      const nodeData = node.data as RouteNodeData;
      if (!nodeData.routeType) return null;
      return { edge: e, node, nodeData };
    })
    .filter(Boolean) as Array<{ edge: TopologyEdge; node: TopologyNode; nodeData: RouteNodeData }>;

  const handleDeleteRoute = async (routeData: RouteNodeData) => {
    const routeName = routeData.resource.metadata?.name ?? '';
    setDeletingRoute(routeName);
    setDeleteError(null);
    try {
      const model = routeModelForType(routeData.routeType);
      await k8sDelete({ model, resource: routeData.resource });
    } catch (err) {
      setDeleteError(String(err));
    } finally {
      setDeletingRoute(null);
    }
  };

  const routeLabel = (type: string) => {
    switch (type) {
      case 'grpc': return { label: 'GRPC', color: 'purple' as const };
      case 'tcp': return { label: 'TCP', color: 'orange' as const };
      case 'tls': return { label: 'TLS', color: 'orange' as const };
      case 'udp': return { label: 'UDP', color: 'blue' as const };
      default: return { label: 'HTTP', color: 'teal' as const };
    }
  };

  return (
    <div style={{ marginTop: '16px' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '8px' }}>
        <strong>Routes ({attachedRoutes.length})</strong>
        {onAddRoute && (
          <Button variant="link" size="sm" icon={<PlusCircleIcon />} onClick={() => onAddRoute(gatewayName)}>
            Add Route
          </Button>
        )}
      </div>

      {deleteError && <Alert variant="danger" title={deleteError} isInline isPlain style={{ marginBottom: '8px' }} />}

      {attachedRoutes.length === 0 ? (
        <span style={{ fontStyle: 'italic', color: 'var(--pf-v6-global--Color--200)' }}>
          No routes attached to this gateway
        </span>
      ) : (
        attachedRoutes.map(({ nodeData }) => {
          const routeName = nodeData.resource.metadata?.name ?? '';
          const routeNs = nodeData.namespace ?? gatewayNamespace;
          const { label: rLabel, color: rColor } = routeLabel(nodeData.routeType);
          const model = routeModelForType(nodeData.routeType);
          const gvkPath = `${model.apiGroup}~${model.apiVersion}~${model.kind}`;

          return (
            <div key={routeName} style={{
              padding: '8px',
              marginBottom: '4px',
              borderRadius: '4px',
              border: '1px solid var(--pf-v6-global--BorderColor--100, #d2d2d2)',
            }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <div>
                  <a href={`/k8s/ns/${routeNs}/${gvkPath}/${routeName}`} style={{ fontWeight: 500 }}>
                    {routeName}
                  </a>
                  <Label color={rColor} isCompact style={{ marginLeft: '6px' }}>{rLabel}</Label>
                </div>
                <div style={{ display: 'flex', gap: '2px' }}>
                  <Button variant="plain" size="sm" component="a" href={`/k8s/ns/${routeNs}/${gvkPath}/${routeName}/yaml`} aria-label="Edit YAML">
                    <PencilAltIcon />
                  </Button>
                  <Button
                    variant="plain"
                    size="sm"
                    onClick={() => handleDeleteRoute(nodeData)}
                    isDisabled={deletingRoute === routeName}
                    aria-label="Delete route"
                  >
                    <TrashIcon color="var(--pf-v6-global--danger-color--100, #c9190b)" />
                  </Button>
                </div>
              </div>
              {nodeData.hostnames?.length > 0 && (
                <div style={{ marginTop: '4px', fontSize: '0.85em', color: 'var(--pf-v6-global--Color--200)' }}>
                  {nodeData.hostnames.join(', ')}
                </div>
              )}
              <div style={{ marginTop: '2px', fontSize: '0.85em', color: 'var(--pf-v6-global--Color--200)' }}>
                {nodeData.rulesCount ?? 0} rule{(nodeData.rulesCount ?? 0) !== 1 ? 's' : ''} · {nodeData.backendCount ?? 0} backend{(nodeData.backendCount ?? 0) !== 1 ? 's' : ''}
              </div>
            </div>
          );
        })
      )}
    </div>
  );
};

// --- Gateway Panel with editing ---

const GatewayPanelContent: React.FC<{
  edge: TopologyEdge;
  graph: GraphModel;
  onAddRoute?: (gatewayName: string) => void;
  serviceNames?: string[];
}> = ({ edge, graph, onAddRoute, serviceNames = [] }) => {
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

      <GatewayRoutesSection
        gatewayName={data.gatewayName}
        gatewayNamespace={data.gatewayNamespace}
        graph={graph}
        serviceNames={serviceNames}
        onAddRoute={onAddRoute}
      />

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

function routeLabelConfig(routeType: string): { label: string; color: 'teal' | 'purple' | 'orange' | 'blue' | 'grey' } {
  switch (routeType) {
    case 'grpc':
      return { label: 'GRPCRoute', color: 'purple' };
    case 'tcp':
      return { label: 'TCPRoute', color: 'orange' };
    case 'tls':
      return { label: 'TLSRoute', color: 'orange' };
    case 'udp':
      return { label: 'UDPRoute', color: 'blue' };
    case 'http':
    default:
      return { label: 'HTTPRoute', color: 'teal' };
  }
}

function formatRuleMatch(routeType: string, rule: Record<string, unknown>): string {
  if (routeType === 'http') {
    const httpRule = rule as import('../../types').HTTPRouteRule;
    return httpRule.matches?.map((m: { path?: { type?: string; value?: string } }) =>
      m.path ? `${m.path.type ?? 'PathPrefix'}:${m.path.value ?? '/'}` : '*',
    ).join(', ') ?? '*';
  }
  if (routeType === 'grpc') {
    const grpcRule = rule as import('../../types').GRPCRouteRule;
    return grpcRule.matches?.map((m: { method?: { service?: string; method?: string } }) => {
      const svc = m.method?.service ?? '*';
      const method = m.method?.method ?? '*';
      return `${svc}/${method}`;
    }).join(', ') ?? '*';
  }
  // tcp, tls, udp have no matches
  return '';
}

function formatRuleBackends(rule: Record<string, unknown>): string {
  const refs = (rule as { backendRefs?: Array<{ name: string; port?: number }> }).backendRefs;
  return refs?.map((b) => `${b.name}${b.port ? ':' + b.port : ''}`).join(', ') ?? 'none';
}

const RoutePanelContent: React.FC<{ node: TopologyNode; serviceNames?: string[] }> = ({ node, serviceNames = [] }) => {
  const data = node.data as RouteNodeData;
  const { label: routeLabel, color: routeColor } = routeLabelConfig(data.routeType);
  const supportsHostnames = data.routeType !== 'tcp' && data.routeType !== 'udp';
  const supportsMatches = data.routeType === 'http' || data.routeType === 'grpc';

  const resource = data.resource as HTTPRouteResource | GRPCRouteResource | TCPRouteResource | TLSRouteResource;
  const rules = (resource.spec as { rules?: Array<Record<string, unknown>> }).rules ?? [];
  const parentStatus = resource.status?.parents ?? [];
  const model = routeModelForType(data.routeType);

  const [patchError, setPatchError] = useState<string | null>(null);
  const [patching, setPatching] = useState(false);
  const [editingRuleIdx, setEditingRuleIdx] = useState<number | null>(null);
  const [editBackends, setEditBackends] = useState<Array<{ name: string; port: number }>>([]);
  const [editHttpPath, setEditHttpPath] = useState({ type: 'PathPrefix', value: '/' });
  const [editGrpcMatch, setEditGrpcMatch] = useState({ service: '', method: '' });
  const [hostnameInput, setHostnameInput] = useState('');
  const [showAddRule, setShowAddRule] = useState(false);
  const [newBackends, setNewBackends] = useState<Array<{ name: string; port: number }>>([{ name: '', port: 8080 }]);
  const [newHttpPath, setNewHttpPath] = useState({ type: 'PathPrefix', value: '/' });
  const [newGrpcMatch, setNewGrpcMatch] = useState({ service: '', method: '' });

  const patchSpec = async (specPatch: Record<string, unknown>) => {
    setPatching(true);
    setPatchError(null);
    try {
      await k8sPatch({
        model,
        resource: data.resource,
        data: [{ op: 'replace', path: '/spec', value: { ...resource.spec, ...specPatch } }],
      });
      return true;
    } catch (err) {
      setPatchError(String(err));
      return false;
    } finally {
      setPatching(false);
    }
  };

  // --- Hostname editing ---
  const addHostname = async () => {
    const h = hostnameInput.trim();
    if (!h) return;
    const current = (resource.spec as { hostnames?: string[] }).hostnames ?? [];
    if (current.includes(h)) return;
    if (await patchSpec({ hostnames: [...current, h] })) {
      setHostnameInput('');
    }
  };

  const removeHostname = async (h: string) => {
    const current = (resource.spec as { hostnames?: string[] }).hostnames ?? [];
    await patchSpec({ hostnames: current.filter((x) => x !== h) });
  };

  // --- Rule editing ---
  const startEditRule = (idx: number) => {
    const rule = rules[idx] as Record<string, unknown>;
    const refs = (rule.backendRefs as Array<{ name: string; port?: number }>) ?? [];
    setEditBackends(refs.map((b) => ({ name: b.name, port: b.port ?? 8080 })));
    if (data.routeType === 'http') {
      const matches = (rule as { matches?: Array<{ path?: { type?: string; value?: string } }> }).matches;
      const m = matches?.[0]?.path;
      setEditHttpPath({ type: m?.type ?? 'PathPrefix', value: m?.value ?? '/' });
    }
    if (data.routeType === 'grpc') {
      const matches = (rule as { matches?: Array<{ method?: { service?: string; method?: string } }> }).matches;
      const m = matches?.[0]?.method;
      setEditGrpcMatch({ service: m?.service ?? '', method: m?.method ?? '' });
    }
    setEditingRuleIdx(idx);
    setPatchError(null);
  };

  const saveEditRule = async () => {
    if (editingRuleIdx === null) return;
    const updated = [...rules];
    const newRule: Record<string, unknown> = {
      backendRefs: editBackends.filter((b) => b.name.trim()).map((b) => ({ name: b.name.trim(), port: b.port })),
    };
    if (data.routeType === 'http' && editHttpPath.value.trim()) {
      newRule.matches = [{ path: { type: editHttpPath.type, value: editHttpPath.value.trim() } }];
    }
    if (data.routeType === 'grpc' && (editGrpcMatch.service.trim() || editGrpcMatch.method.trim())) {
      newRule.matches = [{ method: { ...(editGrpcMatch.service.trim() && { service: editGrpcMatch.service.trim() }), ...(editGrpcMatch.method.trim() && { method: editGrpcMatch.method.trim() }) } }];
    }
    updated[editingRuleIdx] = newRule;
    if (await patchSpec({ rules: updated })) {
      setEditingRuleIdx(null);
    }
  };

  const removeRule = async (idx: number) => {
    const updated = rules.filter((_, i) => i !== idx);
    await patchSpec({ rules: updated });
  };

  const addRule = async () => {
    const newRule: Record<string, unknown> = {
      backendRefs: newBackends.filter((b) => b.name.trim()).map((b) => ({ name: b.name.trim(), port: b.port })),
    };
    if (data.routeType === 'http' && newHttpPath.value.trim()) {
      newRule.matches = [{ path: { type: newHttpPath.type, value: newHttpPath.value.trim() } }];
    }
    if (data.routeType === 'grpc' && (newGrpcMatch.service.trim() || newGrpcMatch.method.trim())) {
      newRule.matches = [{ method: { ...(newGrpcMatch.service.trim() && { service: newGrpcMatch.service.trim() }), ...(newGrpcMatch.method.trim() && { method: newGrpcMatch.method.trim() }) } }];
    }
    if (await patchSpec({ rules: [...rules, newRule] })) {
      setShowAddRule(false);
      setNewBackends([{ name: '', port: 8080 }]);
      setNewHttpPath({ type: 'PathPrefix', value: '/' });
      setNewGrpcMatch({ service: '', method: '' });
    }
  };

  // --- Inline backend editor with service dropdown ---
  const CUSTOM_SERVICE = '__custom__';
  const [customBackendIndices, setCustomBackendIndices] = useState<Set<string>>(new Set());

  const backendsEditor = (
    backends: Array<{ name: string; port: number }>,
    setBackends: (b: Array<{ name: string; port: number }>) => void,
    prefix: string,
  ) => (
    <div>
      <label style={{ fontSize: '0.85em', fontWeight: 600 }}>Backends</label>
      {backends.map((b, i) => {
        const key = `${prefix}-${i}`;
        const isCustomMode = customBackendIndices.has(key);
        const isKnownService = serviceNames.includes(b.name);
        const selectValue = isCustomMode ? CUSTOM_SERVICE : (isKnownService ? b.name : (b.name ? CUSTOM_SERVICE : ''));

        return (
          <div key={i} style={{ marginTop: '8px', padding: '8px', border: '1px solid var(--pf-v6-global--BorderColor--100, #d2d2d2)', borderRadius: '4px' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '4px' }}>
              <span style={{ fontSize: '0.85em', fontWeight: 500 }}>Backend {i + 1}</span>
              <Button variant="plain" size="sm" onClick={() => setBackends(backends.filter((_, j) => j !== i))} isDisabled={backends.length <= 1} aria-label="Remove"><TrashIcon /></Button>
            </div>
            <FormGroup label="Service" fieldId={`${prefix}-svc-${i}`}>
              <FormSelect
                id={`${prefix}-svc-${i}`}
                value={selectValue}
                onChange={(_e, v) => {
                  if (v === CUSTOM_SERVICE) {
                    setCustomBackendIndices((s) => new Set(s).add(key));
                    const u = [...backends]; u[i] = { ...u[i], name: '' }; setBackends(u);
                  } else {
                    setCustomBackendIndices((s) => { const n = new Set(s); n.delete(key); return n; });
                    const u = [...backends]; u[i] = { ...u[i], name: v }; setBackends(u);
                  }
                }}
              >
                <FormSelectOption value="" label="— Select service —" />
                {serviceNames.map((s) => <FormSelectOption key={s} value={s} label={s} />)}
                <FormSelectOption value={CUSTOM_SERVICE} label="Custom..." />
              </FormSelect>
            </FormGroup>
            {selectValue === CUSTOM_SERVICE && (
              <FormGroup label="Custom service name" fieldId={`${prefix}-custom-${i}`} style={{ marginTop: '4px' }}>
                <TextInput
                  id={`${prefix}-custom-${i}`}
                  value={b.name}
                  onChange={(_e, v) => { const u = [...backends]; u[i] = { ...u[i], name: v }; setBackends(u); }}
                  placeholder="my-service"
                />
              </FormGroup>
            )}
            <FormGroup label="Port" fieldId={`${prefix}-port-${i}`} style={{ marginTop: '4px' }}>
              <TextInput
                id={`${prefix}-port-${i}`}
                type="number"
                value={b.port}
                onChange={(_e, v) => { const u = [...backends]; u[i] = { ...u[i], port: parseInt(v, 10) || 0 }; setBackends(u); }}
              />
            </FormGroup>
          </div>
        );
      })}
      <Button variant="link" size="sm" icon={<PlusCircleIcon />} onClick={() => setBackends([...backends, { name: '', port: 8080 }])} style={{ marginTop: '4px' }}>Add backend</Button>
    </div>
  );

  // --- Match editor for a rule ---
  const matchEditor = (
    httpPath: { type: string; value: string },
    setHttpPath: (p: { type: string; value: string }) => void,
    grpcMatch: { service: string; method: string },
    setGrpcMatch: (m: { service: string; method: string }) => void,
    prefix: string,
  ) => {
    if (data.routeType === 'http') {
      return (
        <div style={{ marginBottom: '8px' }}>
          <FormGroup label="Match type" fieldId={`${prefix}-pathtype`}>
            <FormSelect id={`${prefix}-pathtype`} value={httpPath.type} onChange={(_e, v) => setHttpPath({ ...httpPath, type: v })}>
              <FormSelectOption value="PathPrefix" label="PathPrefix" />
              <FormSelectOption value="Exact" label="Exact" />
            </FormSelect>
          </FormGroup>
          <FormGroup label="Path" fieldId={`${prefix}-pathval`} style={{ marginTop: '4px' }}>
            <TextInput id={`${prefix}-pathval`} value={httpPath.value} onChange={(_e, v) => setHttpPath({ ...httpPath, value: v })} placeholder="/" />
          </FormGroup>
        </div>
      );
    }
    if (data.routeType === 'grpc') {
      return (
        <div style={{ marginBottom: '8px' }}>
          <FormGroup label="Service" fieldId={`${prefix}-grpc-svc`}>
            <TextInput id={`${prefix}-grpc-svc`} value={grpcMatch.service} onChange={(_e, v) => setGrpcMatch({ ...grpcMatch, service: v })} placeholder="Service" />
          </FormGroup>
          <FormGroup label="Method" fieldId={`${prefix}-grpc-method`} style={{ marginTop: '4px' }}>
            <TextInput id={`${prefix}-grpc-method`} value={grpcMatch.method} onChange={(_e, v) => setGrpcMatch({ ...grpcMatch, method: v })} placeholder="Method" />
          </FormGroup>
        </div>
      );
    }
    return null;
  };

  return (
    <div style={{ padding: '16px' }}>
      {patchError && <Alert variant="danger" title={patchError} isInline isPlain style={{ marginBottom: '8px' }} />}

      <DescriptionList>
        <DescriptionListGroup>
          <DescriptionListTerm>Type</DescriptionListTerm>
          <DescriptionListDescription>
            <Label color={routeColor} isCompact>{routeLabel}</Label>
          </DescriptionListDescription>
        </DescriptionListGroup>

        {data.namespace && (
          <DescriptionListGroup>
            <DescriptionListTerm>Namespace</DescriptionListTerm>
            <DescriptionListDescription>
              <a href={`/k8s/cluster/namespaces/${data.namespace}`}>{data.namespace}</a>
            </DescriptionListDescription>
          </DescriptionListGroup>
        )}

        {supportsHostnames && (
          <DescriptionListGroup>
            <DescriptionListTerm>Hostnames</DescriptionListTerm>
            <DescriptionListDescription>
              {data.hostnames.length > 0 ? (
                <LabelGroup>
                  {data.hostnames.map((h) => (
                    <Label key={h} isCompact onClose={() => removeHostname(h)}>{h}</Label>
                  ))}
                </LabelGroup>
              ) : (
                <span style={{ fontStyle: 'italic' }}>Any (no hostname filter)</span>
              )}
              <div style={{ display: 'flex', gap: '6px', marginTop: '6px' }}>
                <TextInput
                  value={hostnameInput}
                  onChange={(_e, v) => setHostnameInput(v)}
                  placeholder="Add hostname..."
                  onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addHostname(); } }}
                  style={{ flex: 1 }}
                  isDisabled={patching}
                />
                <Button variant="secondary" size="sm" onClick={addHostname} isDisabled={patching || !hostnameInput.trim()}>Add</Button>
              </div>
            </DescriptionListDescription>
          </DescriptionListGroup>
        )}

        <DescriptionListGroup>
          <DescriptionListTerm>Rules ({rules.length})</DescriptionListTerm>
          <DescriptionListDescription>
            {rules.map((rule, i) => (
              <div key={i} style={{
                padding: '8px',
                marginBottom: '4px',
                borderRadius: '4px',
                border: '1px solid var(--pf-v6-global--BorderColor--100, #d2d2d2)',
                background: editingRuleIdx === i ? 'var(--pf-v6-global--BackgroundColor--200, #f0f0f0)' : 'transparent',
              }}>
                {editingRuleIdx === i ? (
                  <>
                    {matchEditor(editHttpPath, setEditHttpPath, editGrpcMatch, setEditGrpcMatch, `edit-${i}`)}
                    {backendsEditor(editBackends, setEditBackends, `edit-${i}`)}
                    <div style={{ display: 'flex', gap: '4px', marginTop: '8px' }}>
                      <Button variant="plain" size="sm" onClick={saveEditRule} isDisabled={patching} aria-label="Save">
                        <CheckIcon color="var(--pf-v6-global--success-color--100, #3e8635)" />
                      </Button>
                      <Button variant="plain" size="sm" onClick={() => { setEditingRuleIdx(null); setPatchError(null); }} aria-label="Cancel">
                        <TimesIcon />
                      </Button>
                    </div>
                  </>
                ) : (
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                    <span style={{ fontFamily: 'monospace', fontSize: '0.85em' }}>
                      {supportsMatches && <>{formatRuleMatch(data.routeType, rule)}<span style={{ margin: '0 6px', color: 'var(--pf-v6-global--Color--200)' }}>→</span></>}
                      {formatRuleBackends(rule)}
                    </span>
                    <span style={{ display: 'flex', gap: '2px' }}>
                      <Button variant="plain" size="sm" onClick={() => startEditRule(i)} isDisabled={patching} aria-label="Edit rule">
                        <PencilAltIcon />
                      </Button>
                      <Button variant="plain" size="sm" onClick={() => removeRule(i)} isDisabled={patching || rules.length <= 1} aria-label="Remove rule">
                        <TrashIcon color={rules.length <= 1 ? undefined : 'var(--pf-v6-global--danger-color--100, #c9190b)'} />
                      </Button>
                    </span>
                  </div>
                )}
              </div>
            ))}

            {showAddRule ? (
              <div style={{ marginTop: '8px', padding: '8px', borderRadius: '4px', border: '1px dashed var(--pf-v6-global--BorderColor--100, #d2d2d2)' }}>
                {matchEditor(newHttpPath, setNewHttpPath, newGrpcMatch, setNewGrpcMatch, 'add')}
                {backendsEditor(newBackends, setNewBackends, 'add')}
                <div style={{ display: 'flex', gap: '8px', marginTop: '8px' }}>
                  <Button variant="primary" size="sm" onClick={addRule} isDisabled={patching} isLoading={patching}>Add</Button>
                  <Button variant="link" size="sm" onClick={() => { setShowAddRule(false); setPatchError(null); }}>Cancel</Button>
                </div>
              </div>
            ) : (
              <Button variant="link" icon={<PlusCircleIcon />} onClick={() => { setShowAddRule(true); setEditingRuleIdx(null); setPatchError(null); }} style={{ marginTop: '4px' }}>
                Add rule
              </Button>
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

      <RoutePanelActions data={data} />
    </div>
  );
};

// --- Route Panel Actions (delete + view links) ---

const RoutePanelActions: React.FC<{ data: RouteNodeData }> = ({ data }) => {
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  const routeName = data.resource.metadata?.name ?? '';
  const routeNs = data.namespace ?? 'default';
  const model = routeModelForType(data.routeType);
  const gvkPath = `${model.apiGroup}~${model.apiVersion}~${model.kind}`;
  const resourceUrl = `/k8s/ns/${routeNs}/${gvkPath}/${routeName}`;
  const yamlUrl = `${resourceUrl}/yaml`;

  const handleDelete = async () => {
    setDeleting(true);
    setDeleteError(null);
    try {
      await k8sDelete({ model, resource: data.resource });
      setShowDeleteConfirm(false);
    } catch (err) {
      setDeleteError(String(err));
    } finally {
      setDeleting(false);
    }
  };

  return (
    <>
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
        <ModalHeader title={`Delete ${model.kind} "${routeName}"?`} />
        <ModalBody>
          {deleteError && <Alert variant="danger" title={deleteError} isInline style={{ marginBottom: '8px' }} />}
          This will permanently delete <strong>{routeName}</strong> from namespace <strong>{routeNs}</strong>.
        </ModalBody>
        <ModalFooter>
          <Button variant="danger" onClick={handleDelete} isDisabled={deleting} isLoading={deleting}>Delete</Button>
          <Button variant="link" onClick={() => setShowDeleteConfirm(false)}>Cancel</Button>
        </ModalFooter>
      </Modal>
    </>
  );
};

// --- Main Topology Content ---

const TopologyContent: React.FC<TopologyViewProps> = ({ graph, onAddRoute, serviceNames = [] }) => {
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
      panelContent = <GatewayPanelContent edge={edge} graph={graph} onAddRoute={onAddRoute} serviceNames={serviceNames} />;
    }
  } else if (selectedId && selectedType === 'route') {
    const node = graph.nodes.find((n) => n.id === selectedId);
    if (node) {
      panelTitle = node.label;
      panelContent = <RoutePanelContent node={node} serviceNames={serviceNames} />;
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

export const TopologyView: React.FC<TopologyViewProps> = ({ graph, onAddRoute, serviceNames }) => {
  const [visualization] = useState(() => {
    const vis = new Visualization();
    vis.registerComponentFactory(componentFactory);
    vis.registerLayoutFactory(layoutFactory);
    return vis;
  });

  return (
    <VisualizationProvider controller={visualization}>
      <TopologyContent graph={graph} onAddRoute={onAddRoute} serviceNames={serviceNames} />
    </VisualizationProvider>
  );
};
