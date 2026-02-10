import { describe, expect, test } from 'bun:test';
import { renderHistoryContent } from '../daemon/handlers.js';

describe('renderHistoryContent', () => {
  test('renders text-only content unchanged', () => {
    const output = renderHistoryContent([
      { type: 'text', text: 'hello ' },
      { type: 'text', text: 'world' },
    ]);
    expect(output).toBe('hello world');
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

    expect(output).toContain('[File attachment] spec.pdf');
    expect(output).toContain('type=application/pdf');
    expect(output).toContain('size=5 B');
    expect(output).toContain('Attachment text: Important requirement from the attachment.');
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

    expect(output).toContain('[Image attachment] image/png, 5 B');
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

    expect(output).toContain('please review the file\n[File attachment] notes.txt');
  });

  test('falls back to string conversion for non-array content', () => {
    expect(renderHistoryContent('raw string')).toBe('raw string');
    expect(renderHistoryContent({ foo: 'bar' })).toBe('[object Object]');
  });
});
