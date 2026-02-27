import { describe, expect, test } from 'bun:test';

import { classifyIntent, ToolIntent } from '../permissions/intent.js';
import { RiskLevel } from '../permissions/types.js';

const WORKSPACE_DIR = '/tmp/test-workspace';

describe('classifyIntent', () => {
  // ── host_bash: always Write (risk level != intent) ───────────────

  test('host_bash + RiskLevel.Low → Write', () => {
    expect(classifyIntent('host_bash', { command: 'ls' }, WORKSPACE_DIR, RiskLevel.Low)).toBe(ToolIntent.Write);
  });

  test('host_bash + RiskLevel.Medium → Write', () => {
    expect(classifyIntent('host_bash', { command: 'rm -rf /' }, WORKSPACE_DIR, RiskLevel.Medium)).toBe(ToolIntent.Write);
  });

  test('host_bash + RiskLevel.High → Write', () => {
    expect(classifyIntent('host_bash', { command: 'rm -rf /' }, WORKSPACE_DIR, RiskLevel.High)).toBe(ToolIntent.Write);
  });

  // ── Host file tools ───────────────────────────────────────────────

  test('host_file_read → Read', () => {
    expect(classifyIntent('host_file_read', {}, WORKSPACE_DIR, RiskLevel.Low)).toBe(ToolIntent.Read);
  });

  test('host_file_write → Write', () => {
    expect(classifyIntent('host_file_write', {}, WORKSPACE_DIR, RiskLevel.Low)).toBe(ToolIntent.Write);
  });

  test('host_file_edit → Write', () => {
    expect(classifyIntent('host_file_edit', {}, WORKSPACE_DIR, RiskLevel.Low)).toBe(ToolIntent.Write);
  });

  // ── Information retrieval ─────────────────────────────────────────

  test('web_search → Read', () => {
    expect(classifyIntent('web_search', {}, WORKSPACE_DIR, RiskLevel.Low)).toBe(ToolIntent.Read);
  });

  test('web_fetch → Read', () => {
    expect(classifyIntent('web_fetch', {}, WORKSPACE_DIR, RiskLevel.Low)).toBe(ToolIntent.Read);
  });

  // ── Browser tools ─────────────────────────────────────────────────

  test('browser_navigate → Read', () => {
    expect(classifyIntent('browser_navigate', {}, WORKSPACE_DIR, RiskLevel.Low)).toBe(ToolIntent.Read);
  });

  test('browser_click → Read', () => {
    expect(classifyIntent('browser_click', {}, WORKSPACE_DIR, RiskLevel.Low)).toBe(ToolIntent.Read);
  });

  // ── Network request ───────────────────────────────────────────────

  test('network_request → Write', () => {
    expect(classifyIntent('network_request', {}, WORKSPACE_DIR, RiskLevel.Low)).toBe(ToolIntent.Write);
  });

  // ── Scheduling tools ──────────────────────────────────────────────

  test('schedule_create → Write', () => {
    expect(classifyIntent('schedule_create', {}, WORKSPACE_DIR, RiskLevel.Low)).toBe(ToolIntent.Write);
  });

  test('schedule_update → Write', () => {
    expect(classifyIntent('schedule_update', {}, WORKSPACE_DIR, RiskLevel.Low)).toBe(ToolIntent.Write);
  });

  test('schedule_delete → Write', () => {
    expect(classifyIntent('schedule_delete', {}, WORKSPACE_DIR, RiskLevel.Low)).toBe(ToolIntent.Write);
  });

  // ── Workspace-scoped tools ────────────────────────────────────────

  test('file_read (workspace-scoped) → Read', () => {
    expect(
      classifyIntent('file_read', { file_path: `${WORKSPACE_DIR}/foo.txt` }, WORKSPACE_DIR, RiskLevel.Low),
    ).toBe(ToolIntent.Read);
  });

  test('file_write → Read (sandboxed)', () => {
    expect(
      classifyIntent('file_write', { file_path: `${WORKSPACE_DIR}/bar.txt` }, WORKSPACE_DIR, RiskLevel.Low),
    ).toBe(ToolIntent.Read);
  });

  test('file_write (outside workspace) → Write', () => {
    expect(
      classifyIntent('file_write', { file_path: '/etc/shadow' }, WORKSPACE_DIR, RiskLevel.Low),
    ).toBe(ToolIntent.Write);
  });

  test('file_edit (workspace-scoped) → Read', () => {
    expect(
      classifyIntent('file_edit', { file_path: `${WORKSPACE_DIR}/bar.txt` }, WORKSPACE_DIR, RiskLevel.Low),
    ).toBe(ToolIntent.Read);
  });

  test('file_edit (outside workspace) → Write', () => {
    expect(
      classifyIntent('file_edit', { file_path: '/etc/shadow' }, WORKSPACE_DIR, RiskLevel.Low),
    ).toBe(ToolIntent.Write);
  });

  test('bash (sandbox enabled) → Read', () => {
    expect(classifyIntent('bash', { command: 'echo hello' }, WORKSPACE_DIR, RiskLevel.Low)).toBe(ToolIntent.Read);
  });

  // ── External communication ────────────────────────────────────────

  test('send_notification → Write', () => {
    expect(classifyIntent('send_notification', {}, WORKSPACE_DIR, RiskLevel.Low)).toBe(ToolIntent.Write);
  });

  test('call_start → Write', () => {
    expect(classifyIntent('call_start', {}, WORKSPACE_DIR, RiskLevel.Low)).toBe(ToolIntent.Write);
  });

  test('messaging_reply → Write', () => {
    expect(classifyIntent('messaging_reply', {}, WORKSPACE_DIR, RiskLevel.Low)).toBe(ToolIntent.Write);
  });

  // ── Default ───────────────────────────────────────────────────────

  test('unknown tool → Read (default)', () => {
    expect(classifyIntent('some_unknown_tool', {}, WORKSPACE_DIR, RiskLevel.Low)).toBe(ToolIntent.Read);
  });
});
