import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'bun:test';

/**
 * Guard test for the A2A / Pairing convergence analysis document.
 *
 * Verifies that the convergence analysis covers all required sections
 * and references the key source files from both systems. This prevents
 * the document from drifting out of sync if sections are accidentally
 * removed during edits.
 */

const docsDir = join(import.meta.dir, '..', '..', 'docs', 'architecture');

function readDoc(filename: string): string {
  return readFileSync(join(docsDir, filename), 'utf-8');
}

describe('a2a-pairing-convergence analysis guard', () => {
  const convergenceDoc = readDoc('a2a-pairing-convergence.md');

  // -----------------------------------------------------------------------
  // Required sections
  // -----------------------------------------------------------------------

  const requiredSections = [
    { heading: '## 1. Catalog of Shared Patterns', description: 'catalogs shared patterns between A2A and pairing' },
    { heading: '## 2. Candidates for Extraction', description: 'identifies candidates for extraction into shared utilities' },
    { heading: '## 3. Risk / Benefit Assessment', description: 'assesses risk/benefit of convergence' },
    { heading: '## 4. Recommendation', description: 'recommends whether to converge' },
    { heading: '## 5. Phased Convergence Plan', description: 'provides a concrete phased plan' },
    { heading: '## 6. What NOT to Converge', description: 'explicitly scopes out non-candidates' },
    { heading: '## 7. Decision Log', description: 'records decisions with rationale' },
  ];

  for (const { heading, description } of requiredSections) {
    it(`contains required section: ${heading}`, () => {
      expect(convergenceDoc).toContain(heading);
    });
  }

  // -----------------------------------------------------------------------
  // Key A2A files must be referenced
  // -----------------------------------------------------------------------

  const requiredA2AReferences = [
    'a2a-handshake.ts',
    'a2a-peer-auth.ts',
    'a2a-peer-connection-store.ts',
    'a2a-rate-limiter.ts',
  ];

  for (const file of requiredA2AReferences) {
    it(`references A2A source file: ${file}`, () => {
      expect(convergenceDoc).toContain(file);
    });
  }

  // -----------------------------------------------------------------------
  // Key pairing files must be referenced
  // -----------------------------------------------------------------------

  const requiredPairingReferences = [
    'pairing-store.ts',
    'approved-devices-store.ts',
    'channel-guardian-service.ts',
  ];

  for (const file of requiredPairingReferences) {
    it(`references pairing source file: ${file}`, () => {
      expect(convergenceDoc).toContain(file);
    });
  }

  // -----------------------------------------------------------------------
  // Shared patterns must be cataloged
  // -----------------------------------------------------------------------

  const requiredPatterns = [
    'SHA-256',
    'Timing-Safe Comparison',
    'Numeric Code Generation',
    'TTL',
    'Rate Limiting',
    'Invite Token',
    'State Machine',
  ];

  for (const pattern of requiredPatterns) {
    it(`catalogs shared pattern: ${pattern}`, () => {
      expect(convergenceDoc.toLowerCase()).toContain(pattern.toLowerCase());
    });
  }

  // -----------------------------------------------------------------------
  // Architecture doc must cross-reference the convergence analysis
  // -----------------------------------------------------------------------

  it('a2a-architecture.md links to the convergence analysis', () => {
    const archDoc = readDoc('a2a-architecture.md');
    expect(archDoc).toContain('a2a-pairing-convergence.md');
  });

  // -----------------------------------------------------------------------
  // Phased plan must include rollback safety
  // -----------------------------------------------------------------------

  it('phased plan includes rollback safety', () => {
    // The plan must mention rollback for each phase
    const planSection = convergenceDoc.split('## 5. Phased Convergence Plan')[1] ?? '';
    const rollbackCount = (planSection.match(/[Rr]ollback/g) ?? []).length;
    expect(rollbackCount).toBeGreaterThanOrEqual(3);
  });
});
