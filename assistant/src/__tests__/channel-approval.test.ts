import { describe, expect, test } from 'bun:test';

import { parseApprovalDecision } from '../runtime/channel-approval-parser.js';

// ═══════════════════════════════════════════════════════════════════════════
// Plain-text approval decision parser
// ═══════════════════════════════════════════════════════════════════════════

describe('parseApprovalDecision', () => {
  // ── Approve once ──────────────────────────────────────────────────

  test.each([
    'yes',
    'Yes',
    'YES',
    'approve',
    'Approve',
    'APPROVE',
    'allow',
    'Allow',
    'go ahead',
    'Go Ahead',
    'GO AHEAD',
    'approve once',
    'Approve once',
    'Approve Once',
    'APPROVE ONCE',
  ])('recognises "%s" as approve_once', (input) => {
    const result = parseApprovalDecision(input);
    expect(result).not.toBeNull();
    expect(result!.action).toBe('approve_once');
    expect(result!.source).toBe('plain_text');
  });

  // ── Approve always ────────────────────────────────────────────────

  test.each([
    'always',
    'Always',
    'ALWAYS',
    'approve always',
    'Approve Always',
    'APPROVE ALWAYS',
    'allow always',
    'Allow Always',
    'ALLOW ALWAYS',
  ])('recognises "%s" as approve_always', (input) => {
    const result = parseApprovalDecision(input);
    expect(result).not.toBeNull();
    expect(result!.action).toBe('approve_always');
    expect(result!.source).toBe('plain_text');
  });

  // ── Reject ────────────────────────────────────────────────────────

  test.each([
    'no',
    'No',
    'NO',
    'reject',
    'Reject',
    'REJECT',
    'deny',
    'Deny',
    'DENY',
    'cancel',
    'Cancel',
    'CANCEL',
  ])('recognises "%s" as reject', (input) => {
    const result = parseApprovalDecision(input);
    expect(result).not.toBeNull();
    expect(result!.action).toBe('reject');
    expect(result!.source).toBe('plain_text');
  });

  // ── Whitespace handling ───────────────────────────────────────────

  test('trims leading and trailing whitespace', () => {
    const result = parseApprovalDecision('  approve  ');
    expect(result).not.toBeNull();
    expect(result!.action).toBe('approve_once');
  });

  test('trims tabs and newlines', () => {
    const result = parseApprovalDecision('\t\nreject\n\t');
    expect(result).not.toBeNull();
    expect(result!.action).toBe('reject');
  });

  // ── Non-matching text ─────────────────────────────────────────────

  test.each([
    '',
    '   ',
    'hello',
    'please approve this',
    'I approve',
    'yes please',
    'nope',
    'approved',
    'allow me',
    'go',
    'ahead',
    'maybe',
  ])('returns null for non-matching text: "%s"', (input) => {
    expect(parseApprovalDecision(input)).toBeNull();
  });

  // ── Request-reference tag extraction ────────────────────────────────

  test('extracts requestId from [ref:...] tag with approve decision', () => {
    const result = parseApprovalDecision('yes [ref:req-abc-123]');
    expect(result).not.toBeNull();
    expect(result!.action).toBe('approve_once');
    expect(result!.source).toBe('plain_text');
    expect(result!.requestId).toBe('req-abc-123');
  });

  test('extracts requestId from [ref:...] tag with reject decision', () => {
    const result = parseApprovalDecision('no [ref:req-xyz-456]');
    expect(result).not.toBeNull();
    expect(result!.action).toBe('reject');
    expect(result!.requestId).toBe('req-xyz-456');
  });

  test('extracts requestId from [ref:...] tag with always decision', () => {
    const result = parseApprovalDecision('always [ref:req-789]');
    expect(result).not.toBeNull();
    expect(result!.action).toBe('approve_always');
    expect(result!.requestId).toBe('req-789');
  });

  test('handles ref tag on separate line', () => {
    const result = parseApprovalDecision('yes\n[ref:req-abc-123]');
    expect(result).not.toBeNull();
    expect(result!.action).toBe('approve_once');
    expect(result!.requestId).toBe('req-abc-123');
  });

  test('decision without ref tag has no requestId', () => {
    const result = parseApprovalDecision('yes');
    expect(result).not.toBeNull();
    expect(result!.requestId).toBeUndefined();
  });
});
