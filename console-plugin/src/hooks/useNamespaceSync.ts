import { useEffect, useRef, useCallback } from 'react';
import { useActiveNamespace } from '@openshift-console/dynamic-plugin-sdk';

const ALL_NS_SLUG = 'all-namespaces';
const ALL_NS_VALUE = '#ALL_NS#';
const NS_PREFIX = '/portail-topology/ns/';
const ALL_NS_PATH = '/portail-topology/all-namespaces';

function getNsFromPath(): string | undefined {
  const path = window.location.pathname;
  if (path === ALL_NS_PATH || path === ALL_NS_PATH + '/') {
    return ALL_NS_SLUG;
  }
  if (path.startsWith(NS_PREFIX)) {
    return path.slice(NS_PREFIX.length).split('/')[0] || undefined;
  }
  return undefined;
}

function buildUrl(slug: string): string {
  return slug === ALL_NS_SLUG ? ALL_NS_PATH : `${NS_PREFIX}${slug}`;
}

function nsToSlug(ns: string): string {
  return ns === ALL_NS_VALUE ? ALL_NS_SLUG : ns;
}

function slugToNs(slug: string): string {
  return slug === ALL_NS_SLUG ? ALL_NS_VALUE : slug;
}

function replaceUrl(slug: string): void {
  const target = buildUrl(slug);
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
