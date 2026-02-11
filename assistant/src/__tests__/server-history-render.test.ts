import { describe, expect, test } from 'bun:test';
import { renderHistoryContent, mergeToolResults } from '../daemon/handlers.js';

describe('renderHistoryContent', () => {
  test('renders text-only content unchanged', () => {
    const output = renderHistoryContent([
      { type: 'text', text: 'hello ' },
      { type: 'text', text: 'world' },
    ]);
    expect(output.text).toBe('hello world');
    expect(output.toolCalls).toEqual([]);
  });

  test('renders file attachments for attachment-only turns', () => {
    const output = renderHistoryContent([
      {
        type: 'file',
        source: {
          type: 'base64',
          media_type: 'application/pdf',
          filename: 'spec.pdf',
          data: Buffer.from('hello').toString('base64'),
        },
        extracted_text: 'Important requirement from the attachment.',
      },
    ]);

    expect(output.text).toContain('[File attachment] spec.pdf');
    expect(output.text).toContain('type=application/pdf');
    expect(output.text).toContain('size=5 B');
    expect(output.text).toContain('Attachment text: Important requirement from the attachment.');
  });

  test('renders image attachments in history output', () => {
    const output = renderHistoryContent([
      {
        type: 'image',
        source: {
          type: 'base64',
          media_type: 'image/png',
          data: Buffer.from('hello').toString('base64'),
        },
      },
    ]);

    expect(output.text).toContain('[Image attachment] image/png, 5 B');
  });

  test('appends attachment lines after text content', () => {
    const output = renderHistoryContent([
      { type: 'text', text: 'please review the file' },
      {
        type: 'file',
        source: {
          type: 'base64',
          media_type: 'text/plain',
          filename: 'notes.txt',
          data: Buffer.from('hello').toString('base64'),
        },
      },
    ]);

    expect(output.text).toContain('please review the file\n[File attachment] notes.txt');
  });

  test('falls back to string conversion for non-array content', () => {
    expect(renderHistoryContent('raw string').text).toBe('raw string');
    expect(renderHistoryContent({ foo: 'bar' }).text).toBe('[object Object]');
  });

  test('extracts tool_use blocks into toolCalls', () => {
    const output = renderHistoryContent([
      { type: 'tool_use', id: 'tu_1', name: 'web_fetch', input: { url: 'https://example.com' } },
    ]);

    expect(output.text).toBe('');
    expect(output.toolCalls).toEqual([
      { name: 'web_fetch', input: { url: 'https://example.com' } },
    ]);
  });

  test('pairs tool_result with matching tool_use by id', () => {
    const output = renderHistoryContent([
      { type: 'tool_use', id: 'tu_1', name: 'bash', input: { command: 'ls' } },
      { type: 'tool_result', tool_use_id: 'tu_1', content: 'file1.txt\nfile2.txt', is_error: false },
    ]);

    expect(output.toolCalls).toEqual([
      { name: 'bash', input: { command: 'ls' }, result: 'file1.txt\nfile2.txt', isError: false },
    ]);
  });

  test('marks error tool results', () => {
    const output = renderHistoryContent([
      { type: 'tool_use', id: 'tu_1', name: 'bash', input: { command: 'bad' } },
      { type: 'tool_result', tool_use_id: 'tu_1', content: 'command not found', is_error: true },
    ]);

    expect(output.toolCalls).toEqual([
      { name: 'bash', input: { command: 'bad' }, result: 'command not found', isError: true },
    ]);
  });

  test('handles mixed text and tool blocks', () => {
    const output = renderHistoryContent([
      { type: 'text', text: 'Let me look that up.' },
      { type: 'tool_use', id: 'tu_1', name: 'web_fetch', input: { url: 'https://example.com' } },
      { type: 'tool_result', tool_use_id: 'tu_1', content: 'page content here' },
    ]);

    expect(output.text).toBe('Let me look that up.');
    expect(output.toolCalls).toHaveLength(1);
    expect(output.toolCalls[0].name).toBe('web_fetch');
    expect(output.toolCalls[0].result).toBe('page content here');
  });

  test('handles orphan tool_result without matching tool_use', () => {
    const output = renderHistoryContent([
      { type: 'tool_result', tool_use_id: 'missing', content: 'some result' },
    ]);

    expect(output.toolCalls).toEqual([
      { name: 'unknown', input: {}, result: 'some result', isError: false },
    ]);
  });
});

describe('mergeToolResults', () => {
  test('merges tool_result user messages into preceding assistant toolCalls', () => {
    const result = mergeToolResults([
      { role: 'user', text: 'fetch this page', timestamp: 1, toolCalls: [] },
      {
        role: 'assistant', text: '', timestamp: 2,
        toolCalls: [{ name: 'web_fetch', input: { url: 'https://example.com' } }],
      },
      {
        role: 'user', text: '', timestamp: 3,
        toolCalls: [{ name: 'unknown', input: {}, result: 'page content', isError: false }],
      },
      { role: 'assistant', text: 'Here is what I found.', timestamp: 4, toolCalls: [] },
    ]);

    expect(result).toHaveLength(3);
    // The user message with tool_result should be suppressed
    expect(result[0].role).toBe('user');
    expect(result[0].text).toBe('fetch this page');
    // The assistant message should now have the result merged in
    expect(result[1].role).toBe('assistant');
    expect(result[1].toolCalls[0].result).toBe('page content');
    expect(result[1].toolCalls[0].isError).toBe(false);
    // The final assistant text message is unchanged
    expect(result[2].text).toBe('Here is what I found.');
  });

  test('suppresses tool_result-only user messages from visible history', () => {
    const result = mergeToolResults([
      { role: 'user', text: 'hello', timestamp: 1, toolCalls: [] },
      {
        role: 'assistant', text: '', timestamp: 2,
        toolCalls: [{ name: 'bash', input: { command: 'ls' } }],
      },
      {
        role: 'user', text: '', timestamp: 3,
        toolCalls: [{ name: 'unknown', input: {}, result: 'file.txt', isError: false }],
      },
    ]);

    expect(result).toHaveLength(2);
    expect(result.every((m) => !(m.role === 'user' && m.text === ''))).toBe(true);
  });

  test('preserves user messages that have text content alongside tool_results', () => {
    const result = mergeToolResults([
      {
        role: 'user', text: 'user typed something', timestamp: 1,
        toolCalls: [{ name: 'unknown', input: {}, result: 'data', isError: false }],
      },
    ]);

    expect(result).toHaveLength(1);
    expect(result[0].text).toBe('user typed something');
  });

  test('handles multiple tool calls merged from a single result message', () => {
    const result = mergeToolResults([
      {
        role: 'assistant', text: '', timestamp: 1,
        toolCalls: [
          { name: 'bash', input: { command: 'ls' } },
          { name: 'bash', input: { command: 'pwd' } },
        ],
      },
      {
        role: 'user', text: '', timestamp: 2,
        toolCalls: [
          { name: 'unknown', input: {}, result: 'file.txt', isError: false },
          { name: 'unknown', input: {}, result: '/home/user', isError: false },
        ],
      },
    ]);

    expect(result).toHaveLength(1);
    expect(result[0].toolCalls[0].result).toBe('file.txt');
    expect(result[0].toolCalls[1].result).toBe('/home/user');
  });

  test('does not mutate original messages', () => {
    const original = [
      {
        role: 'assistant', text: '', timestamp: 1,
        toolCalls: [{ name: 'bash', input: { command: 'ls' } }],
      },
      {
        role: 'user', text: '', timestamp: 2,
        toolCalls: [{ name: 'unknown', input: {}, result: 'output', isError: false }],
      },
    ];

    mergeToolResults(original);
    // Original assistant toolCalls should not have result attached
    expect((original[0].toolCalls[0] as Record<string, unknown>).result).toBeUndefined();
  });
});
