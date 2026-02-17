import type { AppDefinition } from '../memory/app-store.js';

export const HOME_BASE_REQUIRED_ANCHORS = [
  'home-base-root',
  'home-base-onboarding-lane',
  'home-base-starter-lane',
] as const;

export const HOME_BASE_PREBUILT_DESCRIPTION_PREFIX = '[home-base-prebuilt:v1]';

export function isPrebuiltHomeBaseApp(app: Pick<AppDefinition, 'name' | 'description' | 'htmlDefinition'>): boolean {
  if (app.description?.startsWith(HOME_BASE_PREBUILT_DESCRIPTION_PREFIX)) {
    return true;
  }
  return app.htmlDefinition?.includes('data-vellum-home-base="v1"') ?? false;
}

export function validatePrebuiltHomeBaseHtml(html: string): { valid: boolean; missingAnchors: string[] } {
  const missingAnchors: string[] = [];
  for (const anchor of HOME_BASE_REQUIRED_ANCHORS) {
    const hasId = html.includes(`id="${anchor}"`) || html.includes(`id='${anchor}'`);
    if (!hasId) {
      missingAnchors.push(anchor);
    }
  }
  return {
    valid: missingAnchors.length === 0,
    missingAnchors,
  };
}
