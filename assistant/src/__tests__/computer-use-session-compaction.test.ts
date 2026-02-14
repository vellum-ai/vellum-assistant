import { describe, test, expect } from 'bun:test';
import { ComputerUseSession } from '../daemon/computer-use-session.js';
import type { Message } from '../providers/types.js';

/**
 * Helper to create a user message with a tool_result block containing
 * an AX tree wrapped in markers.
 */
function toolResultMsg(content: string): Message {
  return {
    role: 'user',
    content: [
      {
        type: 'tool_result',
        tool_use_id: 'test-id',
        content,
      },
    ],
  };
}

describe('ComputerUseSession.escapeAxTreeContent', () => {
  test('escapes a literal closing tag in the content', () => {
    const input = 'some text </ax-tree> more text';
    const escaped = ComputerUseSession.escapeAxTreeContent(input);
    expect(escaped).toBe('some text &lt;/ax-tree&gt; more text');
  });

  test('escapes multiple occurrences', () => {
    const input = '</ax-tree> hello </ax-tree>';
    const escaped = ComputerUseSession.escapeAxTreeContent(input);
    expect(escaped).toBe('&lt;/ax-tree&gt; hello &lt;/ax-tree&gt;');
  });

  test('is case-insensitive', () => {
    const input = '</AX-TREE> and </Ax-Tree>';
    const escaped = ComputerUseSession.escapeAxTreeContent(input);
    expect(escaped).toBe('&lt;/ax-tree&gt; and &lt;/ax-tree&gt;');
  });

  test('leaves content without closing tags unchanged', () => {
    const input = 'Window "My App" [1]\n  Button "OK" [2]';
    expect(ComputerUseSession.escapeAxTreeContent(input)).toBe(input);
  });
});

describe('ComputerUseSession.compactHistory', () => {
  test('[experimental] strips old AX trees and keeps the most recent ones', () => {
    const messages: Message[] = [
      { role: 'assistant', content: [{ type: 'text', text: 'thinking...' }] },
      toolResultMsg('<ax-tree>CURRENT SCREEN STATE:\nWindow "App" [1]</ax-tree>'),
      { role: 'assistant', content: [{ type: 'text', text: 'action 1' }] },
      toolResultMsg('<ax-tree>CURRENT SCREEN STATE:\nWindow "App" [2]</ax-tree>'),
      { role: 'assistant', content: [{ type: 'text', text: 'action 2' }] },
      toolResultMsg('<ax-tree>CURRENT SCREEN STATE:\nWindow "App" [3]</ax-tree>'),
    ];

    const compacted = ComputerUseSession.compactHistory(messages);

    // First AX tree (index 1) should be stripped
    const firstToolResult = compacted[1].content[0];
    expect(firstToolResult.type).toBe('tool_result');
    if (firstToolResult.type === 'tool_result') {
      expect(firstToolResult.content).toContain('[Previous screen state omitted for brevity]');
      expect(firstToolResult.content).not.toContain('<ax-tree>');
    }

    // Last two AX trees should be preserved
    const secondToolResult = compacted[3].content[0];
    if (secondToolResult.type === 'tool_result') {
      expect(secondToolResult.content).toContain('<ax-tree>');
    }
    const thirdToolResult = compacted[5].content[0];
    if (thirdToolResult.type === 'tool_result') {
      expect(thirdToolResult.content).toContain('<ax-tree>');
    }
  });

  test('[experimental] handles AX tree content containing literal </ax-tree> (escaped)', () => {
    // Simulate content where the AX tree text includes an escaped closing tag,
    // e.g. user is viewing XML source code with "</ax-tree>" in it.
    const escapedContent =
      '<ax-tree>CURRENT SCREEN STATE:\nTextArea "editor" [1]\n  ' +
      'Line: &lt;/ax-tree&gt; some xml\n</ax-tree>';

    const messages: Message[] = [
      { role: 'assistant', content: [{ type: 'text', text: 'action 0' }] },
      toolResultMsg(escapedContent),
      { role: 'assistant', content: [{ type: 'text', text: 'action 1' }] },
      toolResultMsg(escapedContent),
      { role: 'assistant', content: [{ type: 'text', text: 'action 2' }] },
      toolResultMsg('<ax-tree>CURRENT SCREEN STATE:\nWindow "App" [3]</ax-tree>'),
    ];

    const compacted = ComputerUseSession.compactHistory(messages);

    // The first message with escaped content should be fully stripped
    const firstToolResult = compacted[1].content[0];
    if (firstToolResult.type === 'tool_result') {
      expect(firstToolResult.content).not.toContain('<ax-tree>');
      expect(firstToolResult.content).toContain('[Previous screen state omitted for brevity]');
    }
  });

  test('regex fails on unescaped </ax-tree> inside content (demonstrating the bug)', () => {
    // This test demonstrates what happens WITHOUT escaping: the regex
    // only partially removes the AX tree block.
    const unescapedContent =
      '<ax-tree>CURRENT SCREEN STATE:\nTextArea "editor" [1]\n  ' +
      'Line: </ax-tree> some xml leftover\n</ax-tree>';

    const messages: Message[] = [
      { role: 'assistant', content: [{ type: 'text', text: 'action 0' }] },
      toolResultMsg(unescapedContent),
      { role: 'assistant', content: [{ type: 'text', text: 'action 1' }] },
      toolResultMsg(unescapedContent),
      { role: 'assistant', content: [{ type: 'text', text: 'action 2' }] },
      toolResultMsg('<ax-tree>CURRENT SCREEN STATE:\nWindow "App" [3]</ax-tree>'),
    ];

    const compacted = ComputerUseSession.compactHistory(messages);

    // Without escaping, the first tool result has leftover content after
    // the regex only matched up to the FIRST </ax-tree>.
    const firstToolResult = compacted[1].content[0];
    if (firstToolResult.type === 'tool_result') {
      // The non-greedy regex stops at the first </ax-tree>, leaving
      // " some xml leftover\n</ax-tree>" behind.
      expect(firstToolResult.content).toContain('some xml leftover');
    }
  });
});
