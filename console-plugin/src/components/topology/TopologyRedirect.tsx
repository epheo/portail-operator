import { useEffect } from 'react';
import { useActiveNamespace } from '@openshift-console/dynamic-plugin-sdk';

const TopologyRedirect: React.FC = () => {
  const [activeNamespace] = useActiveNamespace();

  useEffect(() => {
    const target = activeNamespace === '#ALL_NS#'
      ? '/portail-topology/all-namespaces'
      : `/portail-topology/ns/${activeNamespace}`;
    window.history.replaceState(null, '', target);
    window.dispatchEvent(new PopStateEvent('popstate'));
  }, [activeNamespace]);

  return null;
};

export default TopologyRedirect;
