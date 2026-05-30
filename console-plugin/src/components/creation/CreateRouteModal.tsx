import { useState } from 'react';
import {
  Modal,
  ModalBody,
  ModalFooter,
  ModalHeader,
  ModalVariant,
  Form,
  FormGroup,
  TextInput,
  FormSelect,
  FormSelectOption,
  Alert,
  Button,
  Label,
  LabelGroup,
} from '@patternfly/react-core';
import { PlusCircleIcon, TrashIcon } from '@patternfly/react-icons';
import {
  k8sCreate,
  useActiveNamespace,
} from '@openshift-console/dynamic-plugin-sdk';
import { routeModelForType } from '../../constants';
import { GatewayResource } from '../../types';

type RouteType = 'http' | 'grpc' | 'tcp' | 'tls' | 'udp';

interface BackendRef {
  name: string;
  port: number;
}

interface HTTPMatch {
  pathType: string;
  pathValue: string;
}

interface GRPCMatch {
  service: string;
  method: string;
}

interface Rule {
  httpMatches: HTTPMatch[];
  grpcMatches: GRPCMatch[];
  backendRefs: BackendRef[];
}

interface CreateRouteModalProps {
  isOpen: boolean;
  onClose: () => void;
  managedGateways: GatewayResource[];
  preselectedGateway?: string;
  serviceNames?: string[];
}

const ROUTE_TYPES: { value: RouteType; label: string; description: string }[] = [
  { value: 'http', label: 'HTTPRoute', description: 'HTTP/HTTPS traffic routing' },
  { value: 'grpc', label: 'GRPCRoute', description: 'gRPC traffic routing' },
  { value: 'tcp', label: 'TCPRoute', description: 'Raw TCP traffic' },
  { value: 'tls', label: 'TLSRoute', description: 'TLS passthrough' },
  { value: 'udp', label: 'UDPRoute', description: 'Raw UDP traffic' },
];

const PATH_TYPES = ['PathPrefix', 'Exact'];

function emptyRule(): Rule {
  return {
    httpMatches: [{ pathType: 'PathPrefix', pathValue: '/' }],
    grpcMatches: [{ service: '', method: '' }],
    backendRefs: [{ name: '', port: 8080 }],
  };
}

function apiVersionForType(routeType: RouteType): string {
  if (routeType === 'http' || routeType === 'grpc') return 'gateway.networking.k8s.io/v1';
  return 'gateway.networking.k8s.io/v1alpha2';
}

function kindForType(routeType: RouteType): string {
  switch (routeType) {
    case 'http': return 'HTTPRoute';
    case 'grpc': return 'GRPCRoute';
    case 'tcp': return 'TCPRoute';
    case 'tls': return 'TLSRoute';
    case 'udp': return 'UDPRoute';
  }
}

export const CreateRouteModal: React.FC<CreateRouteModalProps> = ({
  isOpen,
  onClose,
  managedGateways,
  preselectedGateway,
  serviceNames = [],
}) => {
  const [activeNamespace] = useActiveNamespace();
  const [routeType, setRouteType] = useState<RouteType>('http');
  const [name, setName] = useState('');
  const [namespace, setNamespace] = useState(activeNamespace !== '#ALL_NS#' ? activeNamespace : 'default');
  const [parentGateway, setParentGateway] = useState(preselectedGateway ?? managedGateways[0]?.metadata?.name ?? '');
  const [hostnames, setHostnames] = useState<string[]>([]);
  const [hostnameInput, setHostnameInput] = useState('');
  const [rules, setRules] = useState<Rule[]>([emptyRule()]);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [customBackendKeys, setCustomBackendKeys] = useState<Set<string>>(new Set());

  const hasHostnames = routeType === 'http' || routeType === 'grpc' || routeType === 'tls';

  const addHostname = () => {
    const h = hostnameInput.trim();
    if (h && !hostnames.includes(h)) {
      setHostnames([...hostnames, h]);
      setHostnameInput('');
    }
  };

  const removeHostname = (h: string) => {
    setHostnames(hostnames.filter((x) => x !== h));
  };

  const updateRule = (index: number, updates: Partial<Rule>) => {
    setRules(rules.map((r, i) => (i === index ? { ...r, ...updates } : r)));
  };

  const addRule = () => setRules([...rules, emptyRule()]);
  const removeRule = (index: number) => setRules(rules.filter((_, i) => i !== index));

  const updateBackendRef = (ruleIdx: number, refIdx: number, updates: Partial<BackendRef>) => {
    const updated = [...rules];
    updated[ruleIdx] = {
      ...updated[ruleIdx],
      backendRefs: updated[ruleIdx].backendRefs.map((b, i) => (i === refIdx ? { ...b, ...updates } : b)),
    };
    setRules(updated);
  };

  const addBackendRef = (ruleIdx: number) => {
    const updated = [...rules];
    updated[ruleIdx] = {
      ...updated[ruleIdx],
      backendRefs: [...updated[ruleIdx].backendRefs, { name: '', port: 8080 }],
    };
    setRules(updated);
  };

  const removeBackendRef = (ruleIdx: number, refIdx: number) => {
    const updated = [...rules];
    updated[ruleIdx] = {
      ...updated[ruleIdx],
      backendRefs: updated[ruleIdx].backendRefs.filter((_, i) => i !== refIdx),
    };
    setRules(updated);
  };

  const buildSpec = () => {
    const spec: Record<string, unknown> = {
      parentRefs: [{ name: parentGateway }],
    };

    if (hasHostnames && hostnames.length > 0) {
      spec.hostnames = hostnames;
    }

    const builtRules = rules.map((rule) => {
      const r: Record<string, unknown> = {};

      if (routeType === 'http' && rule.httpMatches.length > 0) {
        r.matches = rule.httpMatches
          .filter((m) => m.pathValue.trim())
          .map((m) => ({ path: { type: m.pathType, value: m.pathValue.trim() } }));
        if ((r.matches as unknown[]).length === 0) delete r.matches;
      }

      if (routeType === 'grpc' && rule.grpcMatches.length > 0) {
        r.matches = rule.grpcMatches
          .filter((m) => m.service.trim() || m.method.trim())
          .map((m) => ({
            method: {
              ...(m.service.trim() && { service: m.service.trim() }),
              ...(m.method.trim() && { method: m.method.trim() }),
            },
          }));
        if ((r.matches as unknown[]).length === 0) delete r.matches;
      }

      r.backendRefs = rule.backendRefs
        .filter((b) => b.name.trim())
        .map((b) => ({ name: b.name.trim(), port: b.port }));

      return r;
    });

    spec.rules = builtRules;
    return spec;
  };

  const handleCreate = async () => {
    if (!name.trim()) { setError('Route name is required'); return; }
    if (!parentGateway) { setError('Parent Gateway is required'); return; }
    const hasBackends = rules.some((r) => r.backendRefs.some((b) => b.name.trim()));
    if (!hasBackends) { setError('At least one backend ref is required'); return; }

    setCreating(true);
    setError(null);

    try {
      await k8sCreate({
        model: routeModelForType(routeType),
        data: {
          apiVersion: apiVersionForType(routeType),
          kind: kindForType(routeType),
          metadata: { name: name.trim(), namespace },
          spec: buildSpec(),
        },
      });
      onClose();
    } catch (err) {
      setError(String(err));
    } finally {
      setCreating(false);
    }
  };

  return (
    <Modal variant={ModalVariant.large} isOpen={isOpen} onClose={onClose}>
      <ModalHeader title="Create Route" />
      <ModalBody>
        <Form>
          {error && <Alert variant="danger" title={error} isInline style={{ marginBottom: '16px' }} />}

          <FormGroup label="Route Type" fieldId="route-type" isRequired>
            <FormSelect id="route-type" value={routeType} onChange={(_e, v) => setRouteType(v as RouteType)}>
              {ROUTE_TYPES.map((t) => (
                <FormSelectOption key={t.value} value={t.value} label={`${t.label} — ${t.description}`} />
              ))}
            </FormSelect>
          </FormGroup>

          <FormGroup label="Name" fieldId="route-name" isRequired>
            <TextInput id="route-name" value={name} onChange={(_e, v) => setName(v)} isRequired />
          </FormGroup>

          <FormGroup label="Namespace" fieldId="route-ns" isRequired>
            <TextInput id="route-ns" value={namespace} onChange={(_e, v) => setNamespace(v)} />
          </FormGroup>

          <FormGroup label="Parent Gateway" fieldId="route-gw" isRequired>
            <FormSelect id="route-gw" value={parentGateway} onChange={(_e, v) => setParentGateway(v)}>
              {managedGateways.map((gw) => (
                <FormSelectOption
                  key={`${gw.metadata?.namespace}/${gw.metadata?.name}`}
                  value={gw.metadata?.name ?? ''}
                  label={`${gw.metadata?.name} (${gw.metadata?.namespace})`}
                />
              ))}
            </FormSelect>
          </FormGroup>

          {hasHostnames && (
            <FormGroup label="Hostnames" fieldId="route-hostnames">
              <div style={{ display: 'flex', gap: '8px', marginBottom: '8px' }}>
                <TextInput
                  id="route-hostname-input"
                  value={hostnameInput}
                  onChange={(_e, v) => setHostnameInput(v)}
                  placeholder="e.g. example.com"
                  onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addHostname(); } }}
                  style={{ flex: 1 }}
                />
                <Button variant="secondary" size="sm" onClick={addHostname}>Add</Button>
              </div>
              {hostnames.length > 0 && (
                <LabelGroup>
                  {hostnames.map((h) => (
                    <Label key={h} onClose={() => removeHostname(h)}>{h}</Label>
                  ))}
                </LabelGroup>
              )}
            </FormGroup>
          )}

          <FormGroup label="Rules" fieldId="route-rules">
            {rules.map((rule, ruleIdx) => (
              <div key={ruleIdx} style={{
                padding: '12px',
                marginBottom: '8px',
                border: '1px solid var(--pf-v6-global--BorderColor--100, #d2d2d2)',
                borderRadius: '6px',
              }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '8px' }}>
                  <strong>Rule {ruleIdx + 1}</strong>
                  <Button variant="plain" size="sm" onClick={() => removeRule(ruleIdx)} isDisabled={rules.length <= 1} aria-label="Remove rule">
                    <TrashIcon color={rules.length <= 1 ? undefined : 'var(--pf-v6-global--danger-color--100, #c9190b)'} />
                  </Button>
                </div>

                {routeType === 'http' && (
                  <div style={{ marginBottom: '8px' }}>
                    <label style={{ fontSize: '0.85em', fontWeight: 600 }}>Path Match</label>
                    {rule.httpMatches.map((m, mIdx) => (
                      <div key={mIdx} style={{ display: 'flex', gap: '6px', marginTop: '4px' }}>
                        <FormSelect
                          value={m.pathType}
                          onChange={(_e, v) => {
                            const matches = [...rule.httpMatches];
                            matches[mIdx] = { ...matches[mIdx], pathType: v };
                            updateRule(ruleIdx, { httpMatches: matches });
                          }}
                          style={{ width: '140px' }}
                        >
                          {PATH_TYPES.map((t) => <FormSelectOption key={t} value={t} label={t} />)}
                        </FormSelect>
                        <TextInput
                          value={m.pathValue}
                          onChange={(_e, v) => {
                            const matches = [...rule.httpMatches];
                            matches[mIdx] = { ...matches[mIdx], pathValue: v };
                            updateRule(ruleIdx, { httpMatches: matches });
                          }}
                          placeholder="/"
                          style={{ flex: 1 }}
                        />
                      </div>
                    ))}
                  </div>
                )}

                {routeType === 'grpc' && (
                  <div style={{ marginBottom: '8px' }}>
                    <label style={{ fontSize: '0.85em', fontWeight: 600 }}>gRPC Match</label>
                    {rule.grpcMatches.map((m, mIdx) => (
                      <div key={mIdx} style={{ display: 'flex', gap: '6px', marginTop: '4px' }}>
                        <TextInput
                          value={m.service}
                          onChange={(_e, v) => {
                            const matches = [...rule.grpcMatches];
                            matches[mIdx] = { ...matches[mIdx], service: v };
                            updateRule(ruleIdx, { grpcMatches: matches });
                          }}
                          placeholder="Service"
                          style={{ flex: 1 }}
                        />
                        <TextInput
                          value={m.method}
                          onChange={(_e, v) => {
                            const matches = [...rule.grpcMatches];
                            matches[mIdx] = { ...matches[mIdx], method: v };
                            updateRule(ruleIdx, { grpcMatches: matches });
                          }}
                          placeholder="Method"
                          style={{ flex: 1 }}
                        />
                      </div>
                    ))}
                  </div>
                )}

                <div>
                  <label style={{ fontSize: '0.85em', fontWeight: 600 }}>Backend Refs</label>
                  {rule.backendRefs.map((b, bIdx) => {
                    const CUSTOM = '__custom__';
                    const beKey = `${ruleIdx}-${bIdx}`;
                    const isCustomMode = customBackendKeys.has(beKey);
                    const isKnown = serviceNames.includes(b.name);
                    const selectVal = isCustomMode ? CUSTOM : (isKnown ? b.name : (b.name ? CUSTOM : ''));
                    return (
                      <div key={bIdx} style={{ marginTop: '8px', padding: '8px', border: '1px solid var(--pf-v6-global--BorderColor--100, #d2d2d2)', borderRadius: '4px' }}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '4px' }}>
                          <span style={{ fontSize: '0.85em', fontWeight: 500 }}>Backend {bIdx + 1}</span>
                          <Button variant="plain" size="sm" onClick={() => removeBackendRef(ruleIdx, bIdx)} isDisabled={rule.backendRefs.length <= 1} aria-label="Remove backend">
                            <TrashIcon />
                          </Button>
                        </div>
                        <FormGroup label="Service" fieldId={`be-svc-${ruleIdx}-${bIdx}`}>
                          <FormSelect
                            id={`be-svc-${ruleIdx}-${bIdx}`}
                            value={selectVal}
                            onChange={(_e, v) => {
                              if (v === CUSTOM) {
                                setCustomBackendKeys((s) => new Set(s).add(beKey));
                                updateBackendRef(ruleIdx, bIdx, { name: '' });
                              } else {
                                setCustomBackendKeys((s) => { const n = new Set(s); n.delete(beKey); return n; });
                                updateBackendRef(ruleIdx, bIdx, { name: v });
                              }
                            }}
                          >
                            <FormSelectOption value="" label="— Select service —" />
                            {serviceNames.map((s) => <FormSelectOption key={s} value={s} label={s} />)}
                            <FormSelectOption value={CUSTOM} label="Custom..." />
                          </FormSelect>
                        </FormGroup>
                        {selectVal === CUSTOM && (
                          <FormGroup label="Custom service name" fieldId={`be-custom-${ruleIdx}-${bIdx}`} style={{ marginTop: '4px' }}>
                            <TextInput
                              id={`be-custom-${ruleIdx}-${bIdx}`}
                              value={b.name}
                              onChange={(_e, v) => updateBackendRef(ruleIdx, bIdx, { name: v })}
                              placeholder="my-service"
                            />
                          </FormGroup>
                        )}
                        <FormGroup label="Port" fieldId={`be-port-${ruleIdx}-${bIdx}`} style={{ marginTop: '4px' }}>
                          <TextInput
                            id={`be-port-${ruleIdx}-${bIdx}`}
                            type="number"
                            value={b.port}
                            onChange={(_e, v) => updateBackendRef(ruleIdx, bIdx, { port: parseInt(v, 10) || 0 })}
                          />
                        </FormGroup>
                      </div>
                    );
                  })}
                  <Button variant="link" size="sm" icon={<PlusCircleIcon />} onClick={() => addBackendRef(ruleIdx)} style={{ marginTop: '4px' }}>
                    Add backend
                  </Button>
                </div>
              </div>
            ))}
            <Button variant="link" icon={<PlusCircleIcon />} onClick={addRule}>
              Add rule
            </Button>
          </FormGroup>
        </Form>
      </ModalBody>
      <ModalFooter>
        <Button variant="primary" onClick={handleCreate} isDisabled={creating} isLoading={creating}>
          Create
        </Button>
        <Button variant="link" onClick={onClose}>Cancel</Button>
      </ModalFooter>
    </Modal>
  );
};
