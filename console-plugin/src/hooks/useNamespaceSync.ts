import { useEffect, useRef, useCallback } from 'react';
import { useActiveNamespace } from '@openshift-console/dynamic-plugin-sdk';

const ALL_NS_SLUG = 'all-namespaces';
const ALL_NS_VALUE = '#ALL_NS#';
const BASE_PATH = '/portail-topology/ns/';

function nsToSlug(ns: string): string {
  return ns === ALL_NS_VALUE ? ALL_NS_SLUG : ns;
}

function slugToNs(slug: string): string {
  return slug === ALL_NS_SLUG ? ALL_NS_VALUE : slug;
}

function getNsFromPath(): string | undefined {
  const path = window.location.pathname;
  if (path.startsWith(BASE_PATH)) {
    return path.slice(BASE_PATH.length).split('/')[0] || undefined;
  }
  return undefined;
}

function replaceUrl(ns: string): void {
  const target = `${BASE_PATH}${ns}`;
  if (window.location.pathname !== target) {
    window.history.replaceState(null, '', target);
    window.dispatchEvent(new PopStateEvent('popstate'));
  }
}

/**
 * Bidirectional sync between the URL /portail-topology/ns/:ns param
 * and the console's active namespace picker.
 */
export const useNamespaceSync = (): void => {
  const [activeNamespace, setActiveNamespace] = useActiveNamespace();
  const syncSourceRef = useRef<'url' | null>(null);

  const urlNs = getNsFromPath();

  // URL → picker (on mount and popstate)
  const syncFromUrl = useCallback(() => {
    const slug = getNsFromPath();
    if (!slug) return;
    const targetNs = slugToNs(slug);
    if (targetNs !== activeNamespace) {
      syncSourceRef.current = 'url';
      setActiveNamespace(targetNs);
    }
  }, [activeNamespace, setActiveNamespace]);

  // Sync from URL on mount
  useEffect(() => {
    syncFromUrl();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Listen for popstate (browser back/forward)
  useEffect(() => {
    window.addEventListener('popstate', syncFromUrl);
    return () => window.removeEventListener('popstate', syncFromUrl);
  }, [syncFromUrl]);

  // Picker → URL
  useEffect(() => {
    if (syncSourceRef.current === 'url') {
      syncSourceRef.current = null;
      return;
    }
    const expectedSlug = nsToSlug(activeNamespace);
    if (urlNs !== expectedSlug) {
      replaceUrl(expectedSlug);
    }
  }, [activeNamespace, urlNs]);
};
