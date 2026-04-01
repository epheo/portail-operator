import { useEffect } from 'react';
import { useActiveNamespace } from '@openshift-console/dynamic-plugin-sdk';

const TopologyRedirect: React.FC = () => {
  const [activeNamespace] = useActiveNamespace();

  useEffect(() => {
    const ns = activeNamespace === '#ALL_NS#' ? 'all-namespaces' : activeNamespace;
    window.history.replaceState(null, '', `/portail-topology/ns/${ns}`);
    // Dispatch popstate so React Router picks up the change
    window.dispatchEvent(new PopStateEvent('popstate'));
  }, [activeNamespace]);

  return null;
};

export default TopologyRedirect;
