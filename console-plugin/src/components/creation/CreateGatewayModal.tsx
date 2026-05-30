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
  Label,
  Button,
  Radio,
} from '@patternfly/react-core';
import {
  k8sCreate,
  useActiveNamespace,
} from '@openshift-console/dynamic-plugin-sdk';
import { GatewayGVK, NETWORK_ADDRESS_TYPE } from '../../constants';
import {
  TopologyNode,
  GatewayClassResource,
  ListenerInfo,
  GatewayMode,
} from '../../types';
import { ListenerForm } from './ListenerForm';

interface CreateGatewayModalProps {
  isOpen: boolean;
  onClose: () => void;
  sourceNode?: TopologyNode;
  targetNode?: TopologyNode;
  gatewayClasses: GatewayClassResource[];
  availableNetworks: TopologyNode[];
}

export const CreateGatewayModal: React.FC<CreateGatewayModalProps> = ({
  isOpen,
  onClose,
  sourceNode,
  targetNode,
  gatewayClasses,
  availableNetworks,
}) => {
  const [activeNamespace] = useActiveNamespace();
  const [name, setName] = useState('');
  const [namespace, setNamespace] = useState(activeNamespace !== '#ALL_NS#' ? activeNamespace : 'default');
  const [gatewayClassName, setGatewayClassName] = useState(
    gatewayClasses[0]?.metadata?.name ?? '',
  );

  // Default to loadbalancer mode — the primary use case
  const [mode, setMode] = useState<GatewayMode>(
    sourceNode?.type === 'external' ? 'loadbalancer' : 'loadbalancer',
  );

  const [sourceId, setSourceId] = useState(sourceNode?.id ?? '');
  const [targetId, setTargetId] = useState(targetNode?.id ?? '');
  const [listeners, setListeners] = useState<ListenerInfo[]>([
    { name: 'http', protocol: 'HTTP', port: 80 },
  ]);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  const networkNodes = availableNetworks.filter((n) => n.zone === 'cluster' && n.type === 'network');

  const handleCreate = async () => {
    if (!name.trim()) {
      setError('Gateway name is required');
      return;
    }
    if (!gatewayClassName) {
      setError('GatewayClass is required');
      return;
    }

    setCreating(true);
    setError(null);

    try {
      const addresses =
        mode === 'multi-network'
          ? [sourceId, targetId]
              .map((id) => availableNetworks.find((n) => n.id === id))
              .filter((n) => n && n.type === 'network' && 'networkType' in n.data && n.data.networkType !== 'cluster-default')
              .map((n) => ({
                type: NETWORK_ADDRESS_TYPE,
                value: n!.label,
              }))
          : undefined;

      const gatewayResource = {
        apiVersion: 'gateway.networking.k8s.io/v1',
        kind: 'Gateway',
        metadata: {
          name: name.trim(),
          namespace,
        },
        spec: {
          gatewayClassName,
          listeners: listeners.map((l) => ({
            name: l.name,
            protocol: l.protocol,
            port: l.port,
          })),
          ...(addresses && addresses.length > 0 && { addresses }),
        },
      };

      await k8sCreate({
        model: {
          apiGroup: GatewayGVK.group,
          apiVersion: GatewayGVK.version,
          kind: GatewayGVK.kind,
          plural: 'gateways',
          namespaced: true,
          abbr: 'GW',
          label: 'Gateway',
          labelPlural: 'Gateways',
        },
        data: gatewayResource,
      });

      onClose();
    } catch (err) {
      setError(String(err));
    } finally {
      setCreating(false);
    }
  };

  return (
    <Modal variant={ModalVariant.medium} isOpen={isOpen} onClose={onClose}>
      <ModalHeader title="Create Gateway" />
      <ModalBody>
        <Form>
          {error && <Alert variant="danger" title={error} isInline />}

          <FormGroup label="Mode" fieldId="gw-mode" isRequired>
            <Radio
              isChecked={mode === 'loadbalancer'}
              name="gw-mode"
              onChange={() => setMode('loadbalancer')}
              label={
                <>
                  <Label color="blue" isCompact>North/South</Label>
                  {' '}LoadBalancer — expose services externally
                </>
              }
              id="gw-mode-lb"
              value="loadbalancer"
              style={{ marginBottom: '8px' }}
            />
            <Radio
              isChecked={mode === 'multi-network'}
              name="gw-mode"
              onChange={() => setMode('multi-network')}
              label={
                <>
                  <Label color="purple" isCompact>East/West</Label>
                  {' '}Multi-Network — bridge cluster networks
                </>
              }
              id="gw-mode-mn"
              value="multi-network"
            />
          </FormGroup>

          <FormGroup label="Name" fieldId="gw-name" isRequired>
            <TextInput
              id="gw-name"
              value={name}
              onChange={(_event, value) => setName(value)}
              isRequired
            />
          </FormGroup>

          <FormGroup label="Namespace" fieldId="gw-namespace" isRequired>
            <TextInput
              id="gw-namespace"
              value={namespace}
              onChange={(_event, value) => setNamespace(value)}
            />
          </FormGroup>

          <FormGroup label="GatewayClass" fieldId="gw-class" isRequired>
            <FormSelect
              id="gw-class"
              value={gatewayClassName}
              onChange={(_event, value) => setGatewayClassName(value)}
            >
              {gatewayClasses.map((gc) => (
                <FormSelectOption
                  key={gc.metadata?.name}
                  value={gc.metadata?.name}
                  label={gc.metadata?.name ?? ''}
                />
              ))}
            </FormSelect>
          </FormGroup>

          {mode === 'multi-network' && (
            <>
              <FormGroup label="Source Network" fieldId="gw-source">
                <FormSelect
                  id="gw-source"
                  value={sourceId}
                  onChange={(_event, value) => setSourceId(value)}
                >
                  <FormSelectOption key="" value="" label="— Select a network —" />
                  {networkNodes.map((n) => (
                    <FormSelectOption key={n.id} value={n.id} label={n.label} />
                  ))}
                </FormSelect>
              </FormGroup>
              <FormGroup label="Target Network" fieldId="gw-target">
                <FormSelect
                  id="gw-target"
                  value={targetId}
                  onChange={(_event, value) => setTargetId(value)}
                >
                  <FormSelectOption key="" value="" label="— Select a network —" />
                  {networkNodes.map((n) => (
                    <FormSelectOption key={n.id} value={n.id} label={n.label} />
                  ))}
                </FormSelect>
              </FormGroup>
            </>
          )}

          <FormGroup label="Listeners" fieldId="gw-listeners">
            <ListenerForm listeners={listeners} onChange={setListeners} />
          </FormGroup>
        </Form>
      </ModalBody>
      <ModalFooter>
        <Button
          key="create"
          variant="primary"
          onClick={handleCreate}
          isDisabled={creating}
          isLoading={creating}
        >
          Create
        </Button>
        <Button key="cancel" variant="link" onClick={onClose}>
          Cancel
        </Button>
      </ModalFooter>
    </Modal>
  );
};
