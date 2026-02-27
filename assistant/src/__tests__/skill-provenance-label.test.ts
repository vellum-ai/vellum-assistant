import { describe, expect, test } from 'bun:test';

import type { SkillSource } from '../config/skills.js';
import type { SkillProvenance } from '../skills/managed-store.js';
import {
  deriveProvenanceLabel,
  deriveSourceUrl,
  getSkillProvenanceInfo,
} from '../skills/provenance-label.js';

// ─── Test helpers ────────────────────────────────────────────────────────────

function makeSkillsShProvenance(overrides?: Partial<SkillProvenance>): SkillProvenance {
  return {
    provider: 'skills.sh',
    source: 'my-org',
    skillId: 'web-search',
    sourceUrl: 'https://skills.sh/skills/my-org/web-search',
    auditSnapshot: {
      overallRisk: 'low',
      dimensions: [
        { provider: 'ath', risk: 'safe', analyzedAt: '2025-06-01T00:00:00Z' },
        { provider: 'socket', risk: 'low', analyzedAt: '2025-06-01T00:00:00Z' },
      ],
      capturedAt: '2025-06-01T12:00:00Z',
    },
    ...overrides,
  };
}

function makeClawhubProvenance(overrides?: Partial<SkillProvenance>): SkillProvenance {
  return {
    provider: 'clawhub',
    source: 'community',
    skillId: 'my-tool',
    sourceUrl: '',
    ...overrides,
  };
}

// ─── deriveProvenanceLabel ────────────────────────────────────────────────────

describe('deriveProvenanceLabel', () => {
  test('returns "Vellum" for bundled skills', () => {
    expect(deriveProvenanceLabel('bundled', null)).toBe('Vellum');
  });

  test('returns "Vellum" for bundled skills even when provenance exists', () => {
    const provenance = makeSkillsShProvenance();
    expect(deriveProvenanceLabel('bundled', provenance)).toBe('Vellum');
  });

  test('returns "User" for workspace skills', () => {
    expect(deriveProvenanceLabel('workspace', null)).toBe('User');
  });

  test('returns "User" for extra skills', () => {
    expect(deriveProvenanceLabel('extra', null)).toBe('User');
  });

  test('returns "User" for workspace skills even with provenance', () => {
    const provenance = makeSkillsShProvenance();
    expect(deriveProvenanceLabel('workspace', provenance)).toBe('User');
  });

  test('returns "Third-party (skills.sh)" for managed skills with skills.sh provenance', () => {
    const provenance = makeSkillsShProvenance();
    expect(deriveProvenanceLabel('managed', provenance)).toBe('Third-party (skills.sh)');
  });

  test('returns "Third-party (Clawhub)" for managed skills with clawhub provenance', () => {
    const provenance = makeClawhubProvenance();
    expect(deriveProvenanceLabel('managed', provenance)).toBe('Third-party (Clawhub)');
  });

  test('returns "Community" for managed skills without provenance', () => {
    expect(deriveProvenanceLabel('managed', null)).toBe('Community');
  });

  test('returns "Community" for managed skills with unrecognized provider', () => {
    const provenance = makeSkillsShProvenance({ provider: 'unknown-provider' });
    expect(deriveProvenanceLabel('managed', provenance)).toBe('Community');
  });

  test('handles all SkillSource values', () => {
    const sources: SkillSource[] = ['bundled', 'managed', 'workspace', 'extra'];
    for (const source of sources) {
      const label = deriveProvenanceLabel(source, null);
      expect(typeof label).toBe('string');
      expect(label.length).toBeGreaterThan(0);
    }
  });
});

// ─── deriveSourceUrl ─────────────────────────────────────────────────────────

describe('deriveSourceUrl', () => {
  test('returns null for bundled skills', () => {
    expect(deriveSourceUrl('bundled', null)).toBeNull();
  });

  test('returns null for workspace skills', () => {
    expect(deriveSourceUrl('workspace', null)).toBeNull();
  });

  test('returns null for extra skills', () => {
    expect(deriveSourceUrl('extra', null)).toBeNull();
  });

  test('returns null for managed skills without provenance', () => {
    expect(deriveSourceUrl('managed', null)).toBeNull();
  });

  test('returns sourceUrl from skills.sh provenance', () => {
    const provenance = makeSkillsShProvenance();
    expect(deriveSourceUrl('managed', provenance)).toBe(
      'https://skills.sh/skills/my-org/web-search',
    );
  });

  test('constructs sourceUrl for skills.sh when sourceUrl field is empty', () => {
    const provenance = makeSkillsShProvenance({ sourceUrl: '' });
    expect(deriveSourceUrl('managed', provenance)).toBe(
      'https://skills.sh/skills/my-org/web-search',
    );
  });

  test('returns sourceUrl from clawhub provenance if set', () => {
    const provenance = makeClawhubProvenance({
      sourceUrl: 'https://clawhub.example.com/my-tool',
    });
    expect(deriveSourceUrl('managed', provenance)).toBe(
      'https://clawhub.example.com/my-tool',
    );
  });

  test('returns null for clawhub provenance without sourceUrl', () => {
    const provenance = makeClawhubProvenance({ sourceUrl: '' });
    expect(deriveSourceUrl('managed', provenance)).toBeNull();
  });

  test('returns null for bundled skills even with provenance', () => {
    const provenance = makeSkillsShProvenance();
    expect(deriveSourceUrl('bundled', provenance)).toBeNull();
  });
});

// ─── getSkillProvenanceInfo ──────────────────────────────────────────────────

describe('getSkillProvenanceInfo', () => {
  test('returns complete info for bundled skill', () => {
    const info = getSkillProvenanceInfo('bundled', null);
    expect(info).toEqual({
      provenanceLabel: 'Vellum',
      sourceUrl: null,
      provenance: null,
    });
  });

  test('returns complete info for managed skills.sh skill', () => {
    const provenance = makeSkillsShProvenance();
    const info = getSkillProvenanceInfo('managed', provenance);
    expect(info.provenanceLabel).toBe('Third-party (skills.sh)');
    expect(info.sourceUrl).toBe('https://skills.sh/skills/my-org/web-search');
    expect(info.provenance).toBe(provenance);
  });

  test('returns complete info for managed skill without provenance', () => {
    const info = getSkillProvenanceInfo('managed', null);
    expect(info.provenanceLabel).toBe('Community');
    expect(info.sourceUrl).toBeNull();
    expect(info.provenance).toBeNull();
  });

  test('returns complete info for workspace skill', () => {
    const info = getSkillProvenanceInfo('workspace', null);
    expect(info.provenanceLabel).toBe('User');
    expect(info.sourceUrl).toBeNull();
    expect(info.provenance).toBeNull();
  });

  test('returns complete info for extra skill', () => {
    const info = getSkillProvenanceInfo('extra', null);
    expect(info.provenanceLabel).toBe('User');
    expect(info.sourceUrl).toBeNull();
    expect(info.provenance).toBeNull();
  });

  test('returns complete info for clawhub skill', () => {
    const provenance = makeClawhubProvenance({
      sourceUrl: 'https://clawhub.example.com/my-tool',
    });
    const info = getSkillProvenanceInfo('managed', provenance);
    expect(info.provenanceLabel).toBe('Third-party (Clawhub)');
    expect(info.sourceUrl).toBe('https://clawhub.example.com/my-tool');
    expect(info.provenance).toBe(provenance);
  });

  test('provenance field passes through the raw provenance object', () => {
    const provenance = makeSkillsShProvenance();
    const info = getSkillProvenanceInfo('managed', provenance);
    expect(info.provenance).toBe(provenance);
    expect(info.provenance!.auditSnapshot?.overallRisk).toBe('low');
    expect(info.provenance!.auditSnapshot?.dimensions).toHaveLength(2);
  });
});
