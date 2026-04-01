import {
  FormGroup,
  TextInput,
  FormSelect,
  FormSelectOption,
  Button,
  Grid,
  GridItem,
} from '@patternfly/react-core';
import { TrashIcon } from '@patternfly/react-icons';
import { ListenerInfo } from '../../types';

interface ListenerFormProps {
  listeners: ListenerInfo[];
  onChange: (listeners: ListenerInfo[]) => void;
}

const PROTOCOLS = ['HTTP', 'HTTPS', 'TCP', 'TLS', 'UDP', 'GRPC'];

export const ListenerForm: React.FC<ListenerFormProps> = ({
  listeners,
  onChange,
}) => {
  const addListener = () => {
    onChange([
      ...listeners,
      { name: `listener-${listeners.length}`, protocol: 'HTTP', port: 80 },
    ]);
  };

  const removeListener = (index: number) => {
    onChange(listeners.filter((_, i) => i !== index));
  };

  const updateListener = (index: number, updates: Partial<ListenerInfo>) => {
    onChange(
      listeners.map((l, i) => (i === index ? { ...l, ...updates } : l)),
    );
  };

  return (
    <div>
      {listeners.map((listener, index) => (
        <Grid key={index} hasGutter style={{ marginBottom: '16px' }}>
          <GridItem span={4}>
            <FormGroup label="Name" fieldId={`listener-name-${index}`}>
              <TextInput
                id={`listener-name-${index}`}
                value={listener.name}
                onChange={(_event, value) =>
                  updateListener(index, { name: value })
                }
              />
            </FormGroup>
          </GridItem>
          <GridItem span={3}>
            <FormGroup label="Protocol" fieldId={`listener-protocol-${index}`}>
              <FormSelect
                id={`listener-protocol-${index}`}
                value={listener.protocol}
                onChange={(_event, value) =>
                  updateListener(index, { protocol: value })
                }
              >
                {PROTOCOLS.map((p) => (
                  <FormSelectOption key={p} value={p} label={p} />
                ))}
              </FormSelect>
            </FormGroup>
          </GridItem>
          <GridItem span={3}>
            <FormGroup label="Port" fieldId={`listener-port-${index}`}>
              <TextInput
                id={`listener-port-${index}`}
                type="number"
                value={listener.port}
                onChange={(_event, value) =>
                  updateListener(index, { port: parseInt(value, 10) || 0 })
                }
              />
            </FormGroup>
          </GridItem>
          <GridItem span={2}>
            <FormGroup label=" " fieldId={`listener-remove-${index}`}>
              <Button
                variant="plain"
                aria-label="Remove listener"
                onClick={() => removeListener(index)}
                isDisabled={listeners.length <= 1}
              >
                <TrashIcon />
              </Button>
            </FormGroup>
          </GridItem>
        </Grid>
      ))}
      <Button variant="link" onClick={addListener}>
        + Add listener
      </Button>
    </div>
  );
};
