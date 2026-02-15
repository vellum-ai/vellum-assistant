import { describe, expect, test } from 'bun:test';
import { parseSlashCandidate } from '../skills/slash-commands.js';

/**
 * Tests for the slash candidate bypass logic used in handleTaskSubmit.
 *
 * In handleTaskSubmit, a slash candidate bypasses the classifier and
 * routes directly to text_qa. These tests verify the detection logic
 * that drives that bypass.
 */
describe('task_submit slash candidate bypass', () => {
  test('slash candidate bypasses classifier (routes to text_qa)', () => {
    const result = parseSlashCandidate('/start-the-day');
    expect(result.kind).toBe('candidate');
    // In handleTaskSubmit: candidate → text_qa, no classifyInteraction call
  });

  test('slash candidate with args bypasses classifier', () => {
    const result = parseSlashCandidate('/start-the-day weather in SF');
    expect(result.kind).toBe('candidate');
  });

  test('non-slash task still calls classifier', () => {
    const result = parseSlashCandidate('open my email');
    expect(result.kind).toBe('none');
    // In handleTaskSubmit: none → calls classifyInteraction normally
  });

  test('path-like task does not trigger bypass', () => {
    const result = parseSlashCandidate('/Users/sidd/project');
    expect(result.kind).toBe('none');
  });

  test('empty task does not trigger bypass', () => {
    const result = parseSlashCandidate('');
    expect(result.kind).toBe('none');
  });
});
