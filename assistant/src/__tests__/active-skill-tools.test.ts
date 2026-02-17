import { describe, test, expect } from 'bun:test';
import { deriveActiveSkillIds } from '../skills/active-skill-tools.js';
import type { Message } from '../providers/types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Convenience: build a user message with a single tool_result block. */
function toolResultMsg(toolUseId: string, content: string): Message {
  return {
    role: 'user',
    content: [{ type: 'tool_result', tool_use_id: toolUseId, content }],
  };
}

/** Convenience: build a user message with a plain text block. */
function textMsg(role: 'user' | 'assistant', text: string): Message {
  return { role, content: [{ type: 'text', text }] };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('deriveActiveSkillIds', () => {
  test('empty history returns empty array', () => {
    expect(deriveActiveSkillIds([])).toEqual([]);
  });

  test('no markers returns empty array', () => {
    const messages: Message[] = [
      textMsg('user', 'Hello'),
      textMsg('assistant', 'Hi there!'),
      toolResultMsg('t1', 'Some tool output with no markers'),
    ];
    expect(deriveActiveSkillIds(messages)).toEqual([]);
  });

  test('single marker extraction from tool result', () => {
    const messages: Message[] = [
      toolResultMsg('t1', 'Skill loaded.\n\n<loaded_skill id="deploy" />'),
    ];
    expect(deriveActiveSkillIds(messages)).toEqual(['deploy']);
  });

  test('multiple markers from different tool results', () => {
    const messages: Message[] = [
      toolResultMsg('t1', 'Loaded\n\n<loaded_skill id="deploy" />'),
      toolResultMsg('t2', 'Loaded\n\n<loaded_skill id="oncall" />'),
    ];
    expect(deriveActiveSkillIds(messages)).toEqual(['deploy', 'oncall']);
  });

  test('duplicate markers are deduplicated with order preserved', () => {
    const messages: Message[] = [
      toolResultMsg('t1', '<loaded_skill id="deploy" />'),
      toolResultMsg('t2', '<loaded_skill id="oncall" />'),
      toolResultMsg('t3', '<loaded_skill id="deploy" />'),
    ];
    expect(deriveActiveSkillIds(messages)).toEqual(['deploy', 'oncall']);
  });

  test('malformed markers are ignored — missing id attribute', () => {
    const messages: Message[] = [
      toolResultMsg('t1', '<loaded_skill />'),
    ];
    expect(deriveActiveSkillIds(messages)).toEqual([]);
  });

  test('malformed markers are ignored — unclosed tag', () => {
    const messages: Message[] = [
      toolResultMsg('t1', '<loaded_skill id="deploy">'),
    ];
    expect(deriveActiveSkillIds(messages)).toEqual([]);
  });

  test('malformed markers are ignored — wrong tag name', () => {
    const messages: Message[] = [
      toolResultMsg('t1', '<loaded_tool id="deploy" />'),
    ];
    expect(deriveActiveSkillIds(messages)).toEqual([]);
  });

  test('markers in assistant text content are found', () => {
    const messages: Message[] = [
      textMsg('assistant', 'I loaded a skill: <loaded_skill id="review" />'),
    ];
    expect(deriveActiveSkillIds(messages)).toEqual(['review']);
  });

  test('markers in user text content are found', () => {
    const messages: Message[] = [
      textMsg('user', 'Context: <loaded_skill id="debug" />'),
    ];
    expect(deriveActiveSkillIds(messages)).toEqual(['debug']);
  });

  test('mixed valid and invalid markers', () => {
    const messages: Message[] = [
      toolResultMsg('t1', [
        '<loaded_skill id="alpha" />',
        '<loaded_skill />',
        '<loaded_skill id="beta" />',
        '<loaded_tool id="gamma" />',
        '<loaded_skill id="alpha" />',
      ].join('\n')),
    ];
    expect(deriveActiveSkillIds(messages)).toEqual(['alpha', 'beta']);
  });

  test('multiple markers in a single content string', () => {
    const messages: Message[] = [
      toolResultMsg('t1', '<loaded_skill id="a" />\n<loaded_skill id="b" />'),
    ];
    expect(deriveActiveSkillIds(messages)).toEqual(['a', 'b']);
  });

  test('ignores non-text, non-tool-result blocks', () => {
    const messages: Message[] = [
      {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: '<loaded_skill id="hidden" />', signature: 'sig' },
          { type: 'text', text: '<loaded_skill id="visible" />' },
        ],
      },
    ];
    expect(deriveActiveSkillIds(messages)).toEqual(['visible']);
  });
});
