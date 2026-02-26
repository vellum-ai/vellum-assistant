import { describe, expect, test } from 'bun:test';

import { makeSecurityDecision } from '../skills/security-decision.js';
import { createOverrideTracker } from '../skills/install-override.js';
import type { SkillsShAuditReport } from '../skills/skillssh.js';

// ─── makeSecurityDecision ────────────────────────────────────────────────────────

describe('makeSecurityDecision', () => {
  describe('proceed recommendation', () => {
    test('safe risk across all dimensions', () => {
      const audit: SkillsShAuditReport = {
        ath: { risk: 'safe', analyzedAt: '2025-01-01T00:00:00Z' },
        socket: { risk: 'safe', analyzedAt: '2025-01-01T00:00:00Z', score: 95 },
        snyk: { risk: 'safe', analyzedAt: '2025-01-01T00:00:00Z' },
      };

      const decision = makeSecurityDecision(audit);

      expect(decision.recommendation).toBe('proceed');
      expect(decision.overallRisk).toBe('safe');
      expect(decision.rationale).toBe(
        'All security audits passed with safe/low risk ratings.',
      );
    });

    test('low risk across all dimensions', () => {
      const audit: SkillsShAuditReport = {
        ath: { risk: 'low', analyzedAt: '2025-01-01T00:00:00Z' },
        socket: { risk: 'low', analyzedAt: '2025-01-01T00:00:00Z' },
      };

      const decision = makeSecurityDecision(audit);

      expect(decision.recommendation).toBe('proceed');
      expect(decision.overallRisk).toBe('low');
    });

    test('mixed safe and low risk still recommends proceed', () => {
      const audit: SkillsShAuditReport = {
        ath: { risk: 'safe', analyzedAt: '2025-01-01T00:00:00Z' },
        socket: { risk: 'low', analyzedAt: '2025-01-01T00:00:00Z' },
        snyk: { risk: 'safe', analyzedAt: '2025-01-01T00:00:00Z' },
      };

      const decision = makeSecurityDecision(audit);

      expect(decision.recommendation).toBe('proceed');
      expect(decision.overallRisk).toBe('low');
    });
  });

  describe('proceed_with_caution recommendation', () => {
    test('medium risk triggers caution', () => {
      const audit: SkillsShAuditReport = {
        ath: { risk: 'safe', analyzedAt: '2025-01-01T00:00:00Z' },
        socket: { risk: 'medium', analyzedAt: '2025-01-02T00:00:00Z', score: 64 },
        snyk: { risk: 'low', analyzedAt: '2025-01-01T00:00:00Z' },
      };

      const decision = makeSecurityDecision(audit);

      expect(decision.recommendation).toBe('proceed_with_caution');
      expect(decision.overallRisk).toBe('medium');
      expect(decision.rationale).toContain('Medium risk detected');
      expect(decision.rationale).toContain('Socket reports score 64/100');
    });

    test('medium risk with alerts in rationale', () => {
      const audit: SkillsShAuditReport = {
        socket: { risk: 'medium', analyzedAt: '2025-01-02T00:00:00Z', alerts: 1, score: 64 },
      };

      const decision = makeSecurityDecision(audit);

      expect(decision.recommendation).toBe('proceed_with_caution');
      expect(decision.rationale).toContain('1 alert');
      expect(decision.rationale).toContain('score 64/100');
    });
  });

  describe('do_not_recommend recommendation', () => {
    test('high risk triggers do not recommend', () => {
      const audit: SkillsShAuditReport = {
        ath: { risk: 'safe', analyzedAt: '2025-01-01T00:00:00Z' },
        snyk: { risk: 'high', analyzedAt: '2025-01-03T00:00:00Z' },
      };

      const decision = makeSecurityDecision(audit);

      expect(decision.recommendation).toBe('do_not_recommend');
      expect(decision.overallRisk).toBe('high');
      expect(decision.rationale).toContain('High risk detected');
      expect(decision.rationale).toContain('Snyk');
    });

    test('critical risk triggers do not recommend', () => {
      const audit: SkillsShAuditReport = {
        snyk: { risk: 'critical', analyzedAt: '2025-01-03T00:00:00Z', alerts: 5 },
        socket: { risk: 'critical', analyzedAt: '2025-01-03T00:00:00Z', score: 12 },
      };

      const decision = makeSecurityDecision(audit);

      expect(decision.recommendation).toBe('do_not_recommend');
      expect(decision.overallRisk).toBe('critical');
      expect(decision.rationale).toContain('Critical risk detected');
      expect(decision.rationale).toContain('Snyk');
      expect(decision.rationale).toContain('Socket');
    });

    test('unknown risk (empty audit) triggers do not recommend', () => {
      const audit: SkillsShAuditReport = {};

      const decision = makeSecurityDecision(audit);

      expect(decision.recommendation).toBe('do_not_recommend');
      expect(decision.overallRisk).toBe('unknown');
      expect(decision.rationale).toBe(
        'No audit data available. Unable to assess security risk.',
      );
    });

    test('unrecognized risk label treated as unknown', () => {
      const audit: SkillsShAuditReport = {
        ath: { risk: 'banana', analyzedAt: '2025-01-01T00:00:00Z' },
      };

      const decision = makeSecurityDecision(audit);

      expect(decision.recommendation).toBe('do_not_recommend');
      expect(decision.overallRisk).toBe('unknown');
      expect(decision.rationale).toContain('Ath');
    });
  });

  describe('audit dimension summary mapping', () => {
    test('maps all providers present in the audit', () => {
      const audit: SkillsShAuditReport = {
        ath: { risk: 'safe', analyzedAt: '2025-01-01T00:00:00Z' },
        socket: { risk: 'low', analyzedAt: '2025-01-02T00:00:00Z', score: 88 },
        snyk: { risk: 'safe', analyzedAt: '2025-01-03T00:00:00Z', alerts: 0 },
      };

      const decision = makeSecurityDecision(audit);

      expect(decision.auditSummary).toHaveLength(3);
      expect(decision.auditSummary[0]).toEqual({
        provider: 'ath',
        risk: 'safe',
        analyzedAt: '2025-01-01T00:00:00Z',
        details: undefined,
      });
      expect(decision.auditSummary[1]).toEqual({
        provider: 'socket',
        risk: 'low',
        analyzedAt: '2025-01-02T00:00:00Z',
        details: 'score 88/100',
      });
      expect(decision.auditSummary[2]).toEqual({
        provider: 'snyk',
        risk: 'safe',
        analyzedAt: '2025-01-03T00:00:00Z',
        details: '0 alerts',
      });
    });

    test('includes both alerts and score when present', () => {
      const audit: SkillsShAuditReport = {
        socket: { risk: 'medium', analyzedAt: '2025-01-01T00:00:00Z', alerts: 2, score: 55 },
      };

      const decision = makeSecurityDecision(audit);

      expect(decision.auditSummary[0].details).toBe('2 alerts, score 55/100');
    });

    test('singular "alert" for count of 1', () => {
      const audit: SkillsShAuditReport = {
        snyk: { risk: 'low', analyzedAt: '2025-01-01T00:00:00Z', alerts: 1 },
      };

      const decision = makeSecurityDecision(audit);

      expect(decision.auditSummary[0].details).toBe('1 alert');
    });

    test('empty audit produces empty summary', () => {
      const decision = makeSecurityDecision({});

      expect(decision.auditSummary).toEqual([]);
    });

    test('only includes providers with data', () => {
      const audit: SkillsShAuditReport = {
        socket: { risk: 'safe', analyzedAt: '2025-01-01T00:00:00Z' },
      };

      const decision = makeSecurityDecision(audit);

      expect(decision.auditSummary).toHaveLength(1);
      expect(decision.auditSummary[0].provider).toBe('socket');
    });
  });
});

// ─── OverrideTracker ─────────────────────────────────────────────────────────────

describe('OverrideTracker', () => {
  test('initially has no overrides', () => {
    const tracker = createOverrideTracker();

    expect(tracker.getOverrides()).toEqual([]);
    expect(tracker.hasOverride('some-skill', 'some-org/repo')).toBe(false);
  });

  test('records and retrieves an override', () => {
    const tracker = createOverrideTracker();

    tracker.recordOverride({
      skillId: 'dangerous-tool',
      source: 'evil-org/repo',
      overriddenAt: '2025-06-15T10:00:00Z',
      overallRiskAtOverride: 'high',
      recommendation: 'do_not_recommend',
    });

    expect(tracker.hasOverride('dangerous-tool', 'evil-org/repo')).toBe(true);
    expect(tracker.hasOverride('dangerous-tool', 'other-org/repo')).toBe(false);
    expect(tracker.hasOverride('safe-tool', 'evil-org/repo')).toBe(false);

    const overrides = tracker.getOverrides();
    expect(overrides).toHaveLength(1);
    expect(overrides[0]).toEqual({
      skillId: 'dangerous-tool',
      source: 'evil-org/repo',
      overriddenAt: '2025-06-15T10:00:00Z',
      overallRiskAtOverride: 'high',
      recommendation: 'do_not_recommend',
    });
  });

  test('supports multiple overrides for different skills', () => {
    const tracker = createOverrideTracker();

    tracker.recordOverride({
      skillId: 'skill-a',
      source: 'org/repo',
      overriddenAt: '2025-06-15T10:00:00Z',
      overallRiskAtOverride: 'medium',
      recommendation: 'proceed_with_caution',
    });

    tracker.recordOverride({
      skillId: 'skill-b',
      source: 'other/repo',
      overriddenAt: '2025-06-15T11:00:00Z',
      overallRiskAtOverride: 'high',
      recommendation: 'do_not_recommend',
    });

    expect(tracker.hasOverride('skill-a', 'org/repo')).toBe(true);
    expect(tracker.hasOverride('skill-b', 'other/repo')).toBe(true);
    expect(tracker.getOverrides()).toHaveLength(2);
  });

  test('re-recording the same skill keeps a full audit trail', () => {
    const tracker = createOverrideTracker();

    tracker.recordOverride({
      skillId: 'risky-tool',
      source: 'org/repo',
      overriddenAt: '2025-06-15T10:00:00Z',
      overallRiskAtOverride: 'medium',
      recommendation: 'proceed_with_caution',
    });

    tracker.recordOverride({
      skillId: 'risky-tool',
      source: 'org/repo',
      overriddenAt: '2025-06-15T12:00:00Z',
      overallRiskAtOverride: 'high',
      recommendation: 'do_not_recommend',
    });

    expect(tracker.hasOverride('risky-tool', 'org/repo')).toBe(true);
    // Both records kept for audit trail
    expect(tracker.getOverrides()).toHaveLength(2);
    expect(tracker.getOverrides()[0].overallRiskAtOverride).toBe('medium');
    expect(tracker.getOverrides()[1].overallRiskAtOverride).toBe('high');
  });

  test('recordOverride snapshots the input — later mutations do not affect history', () => {
    const tracker = createOverrideTracker();

    const override = {
      skillId: 'tool',
      source: 'org/repo',
      overriddenAt: '2025-06-15T10:00:00Z',
      overallRiskAtOverride: 'medium',
      recommendation: 'proceed_with_caution',
    };

    tracker.recordOverride(override);

    // Mutate the original object after recording
    override.overallRiskAtOverride = 'MUTATED';

    const recorded = tracker.getOverrides();
    expect(recorded[0].overallRiskAtOverride).toBe('medium');
  });

  test('getOverrides entries are independent — mutating one does not affect internals', () => {
    const tracker = createOverrideTracker();

    tracker.recordOverride({
      skillId: 'tool',
      source: 'org/repo',
      overriddenAt: '2025-06-15T10:00:00Z',
      overallRiskAtOverride: 'medium',
      recommendation: 'proceed_with_caution',
    });

    const first = tracker.getOverrides();
    first[0].overallRiskAtOverride = 'MUTATED';

    const second = tracker.getOverrides();
    expect(second[0].overallRiskAtOverride).toBe('medium');
  });

  test('getOverrides returns a defensive copy', () => {
    const tracker = createOverrideTracker();

    tracker.recordOverride({
      skillId: 'tool',
      source: 'org/repo',
      overriddenAt: '2025-06-15T10:00:00Z',
      overallRiskAtOverride: 'medium',
      recommendation: 'proceed_with_caution',
    });

    const first = tracker.getOverrides();
    const second = tracker.getOverrides();
    expect(first).not.toBe(second);
    expect(first).toEqual(second);
  });
});
