import { describe, expect, test } from 'bun:test';
import { reconcilePlaybook } from '../onboarding/playbooks/reconcile.js';

describe('onboarding playbook reconciliation', () => {
  test('marks matching unchecked tasks complete and appends audit note', () => {
    const current = [
      '# Telegram Onboarding Playbook',
      '',
      '## Checklist',
      '- [ ] Start talking to your assistant',
      '- [ ] Define assistant identity and personality (or confirm existing)',
      '- [ ] Defer dashboard-only tasks to desktop Home Base with clear handoff',
      '',
    ].join('\n');

    const desktop = [
      '# Desktop Onboarding Playbook',
      '',
      '## Checklist',
      '- [x] Start talking to your assistant',
      '- [x] Define assistant identity and personality (or confirm existing)',
      '',
    ].join('\n');

    const result = reconcilePlaybook({
      currentChannelId: 'telegram',
      currentContent: current,
      sources: [{ channelId: 'desktop', content: desktop }],
      now: new Date('2026-02-16T18:00:00.000Z'),
    });

    expect(result.changed).toBe(true);
    expect(result.reconciledSteps).toEqual([
      'Start talking to your assistant',
      'Define assistant identity and personality (or confirm existing)',
    ]);
    expect(result.sourceChannels).toEqual(['desktop']);
    expect(result.reconciledContent).toContain('- [x] Start talking to your assistant');
    expect(result.reconciledContent).toContain('## Reconciliation Audit');
    expect(result.reconciledContent).toContain('desktop');
  });

  test('returns unchanged content when no sources are provided', () => {
    const current = [
      '# Mobile Onboarding Playbook',
      '',
      '## Checklist',
      '- [ ] Start talking to your assistant',
      '',
    ].join('\n');

    const result = reconcilePlaybook({
      currentChannelId: 'mobile',
      currentContent: current,
      sources: [],
    });

    expect(result.changed).toBe(false);
    expect(result.reconciledSteps).toHaveLength(0);
    expect(result.sourceChannels).toHaveLength(0);
    expect(result.reconciledContent).toBe(current);
  });
});
