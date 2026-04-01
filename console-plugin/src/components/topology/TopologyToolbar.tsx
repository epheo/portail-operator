import {
  Toolbar,
  ToolbarContent,
  ToolbarItem,
  Button,
  Label,
} from '@patternfly/react-core';
import { useActiveNamespace } from '@openshift-console/dynamic-plugin-sdk';

interface TopologyToolbarProps {
  onCreateGateway?: () => void;
}

export const TopologyToolbar: React.FC<TopologyToolbarProps> = ({ onCreateGateway }) => {
  const [activeNamespace] = useActiveNamespace();
  const nsLabel = activeNamespace === '#ALL_NS#' ? 'All Namespaces' : activeNamespace;

  return (
    <Toolbar className="portail-toolbar">
      <ToolbarContent>
        <ToolbarItem>
          <Button variant="primary" onClick={onCreateGateway}>
            Create Gateway
          </Button>
        </ToolbarItem>
        <ToolbarItem>
          <Label className="portail-namespace-chip" color="blue" isCompact>
            {nsLabel}
          </Label>
        </ToolbarItem>
      </ToolbarContent>
    </Toolbar>
  );
};
