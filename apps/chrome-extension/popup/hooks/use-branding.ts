import { useMemo } from 'react';

interface Branding {
  name: string;
  icons: {
    icon48: string;
    icon128: string;
  };
}

export function useBranding(): Branding {
  return useMemo(() => {
    const manifest = chrome.runtime.getManifest();
    const manifestIcons = manifest.icons as Record<string, string> | undefined;
    const icon48 = manifestIcons?.['48']
      ? chrome.runtime.getURL(manifestIcons['48'])
      : '';
    const icon128 = manifestIcons?.['128']
      ? chrome.runtime.getURL(manifestIcons['128'])
      : '';
    const name =
      typeof manifest.name === 'string' ? manifest.name : 'Vellum Assistant';
    return { name, icons: { icon48, icon128 } };
  }, []);
}
