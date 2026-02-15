import { describe, test, expect } from 'bun:test';
import {
  estimateBase64Bytes,
  inferMimeType,
  classifyKind,
  validateDrafts,
  MAX_ASSISTANT_ATTACHMENTS,
  MAX_ASSISTANT_ATTACHMENT_BYTES,
  type AssistantAttachmentDraft,
} from '../daemon/assistant-attachments.js';

// ---------------------------------------------------------------------------
// estimateBase64Bytes
// ---------------------------------------------------------------------------

describe('estimateBase64Bytes', () => {
  test('returns 0 for empty string', () => {
    expect(estimateBase64Bytes('')).toBe(0);
  });

  test('handles no-padding base64', () => {
    // "abc" → base64 "YWJj" (4 chars, 0 padding → 3 bytes)
    expect(estimateBase64Bytes('YWJj')).toBe(3);
  });

  test('handles single-pad base64', () => {
    // "ab" → base64 "YWI=" (4 chars, 1 padding → 2 bytes)
    expect(estimateBase64Bytes('YWI=')).toBe(2);
  });

  test('handles double-pad base64', () => {
    // "a" → base64 "YQ==" (4 chars, 2 padding → 1 byte)
    expect(estimateBase64Bytes('YQ==')).toBe(1);
  });

  test('estimates correctly for longer strings', () => {
    // 12 base64 chars, no padding → 9 bytes
    expect(estimateBase64Bytes('SGVsbG8gV29y')).toBe(9);
  });
});

// ---------------------------------------------------------------------------
// inferMimeType
// ---------------------------------------------------------------------------

describe('inferMimeType', () => {
  test('infers image types', () => {
    expect(inferMimeType('photo.png')).toBe('image/png');
    expect(inferMimeType('photo.jpg')).toBe('image/jpeg');
    expect(inferMimeType('photo.jpeg')).toBe('image/jpeg');
    expect(inferMimeType('sticker.webp')).toBe('image/webp');
    expect(inferMimeType('icon.gif')).toBe('image/gif');
    expect(inferMimeType('diagram.svg')).toBe('image/svg+xml');
  });

  test('infers document types', () => {
    expect(inferMimeType('report.pdf')).toBe('application/pdf');
    expect(inferMimeType('data.json')).toBe('application/json');
    expect(inferMimeType('notes.txt')).toBe('text/plain');
    expect(inferMimeType('readme.md')).toBe('text/markdown');
    expect(inferMimeType('table.csv')).toBe('text/csv');
  });

  test('is case-insensitive on extension', () => {
    expect(inferMimeType('PHOTO.PNG')).toBe('image/png');
    expect(inferMimeType('Report.PDF')).toBe('application/pdf');
  });

  test('returns octet-stream for unknown extension', () => {
    expect(inferMimeType('file.xyz')).toBe('application/octet-stream');
  });

  test('returns octet-stream for no extension', () => {
    expect(inferMimeType('Makefile')).toBe('application/octet-stream');
  });

  test('uses last extension for double-dotted names', () => {
    expect(inferMimeType('archive.tar.gz')).toBe('application/gzip');
  });
});

// ---------------------------------------------------------------------------
// classifyKind
// ---------------------------------------------------------------------------

describe('classifyKind', () => {
  test('classifies image mime types as image', () => {
    expect(classifyKind('image/png')).toBe('image');
    expect(classifyKind('image/jpeg')).toBe('image');
    expect(classifyKind('image/webp')).toBe('image');
  });

  test('classifies non-image mime types as document', () => {
    expect(classifyKind('application/pdf')).toBe('document');
    expect(classifyKind('text/plain')).toBe('document');
    expect(classifyKind('application/octet-stream')).toBe('document');
  });
});

// ---------------------------------------------------------------------------
// validateDrafts
// ---------------------------------------------------------------------------

function makeDraft(overrides: Partial<AssistantAttachmentDraft> = {}): AssistantAttachmentDraft {
  return {
    sourceType: 'sandbox_file',
    filename: 'test.txt',
    mimeType: 'text/plain',
    dataBase64: 'dGVzdA==',
    sizeBytes: 4,
    kind: 'document',
    ...overrides,
  };
}

describe('validateDrafts', () => {
  test('accepts drafts within limits', () => {
    const drafts = [makeDraft({ filename: 'a.txt' }), makeDraft({ filename: 'b.txt' })];
    const result = validateDrafts(drafts);
    expect(result.accepted).toHaveLength(2);
    expect(result.warnings).toHaveLength(0);
  });

  test('rejects oversized attachments', () => {
    const drafts = [makeDraft({ filename: 'big.bin', sizeBytes: MAX_ASSISTANT_ATTACHMENT_BYTES + 1 })];
    const result = validateDrafts(drafts);
    expect(result.accepted).toHaveLength(0);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain('big.bin');
    expect(result.warnings[0]).toContain('exceeds');
  });

  test('truncates beyond max count', () => {
    const drafts = Array.from({ length: MAX_ASSISTANT_ATTACHMENTS + 2 }, (_, i) =>
      makeDraft({ filename: `file-${i}.txt` }),
    );
    const result = validateDrafts(drafts);
    expect(result.accepted).toHaveLength(MAX_ASSISTANT_ATTACHMENTS);
    expect(result.warnings).toHaveLength(2);
    expect(result.warnings[0]).toContain(`file-${MAX_ASSISTANT_ATTACHMENTS}.txt`);
    expect(result.warnings[0]).toContain('exceeded maximum');
  });

  test('rejects oversized before applying count cap', () => {
    const drafts = [
      makeDraft({ filename: 'big.bin', sizeBytes: MAX_ASSISTANT_ATTACHMENT_BYTES + 1 }),
      ...Array.from({ length: MAX_ASSISTANT_ATTACHMENTS }, (_, i) =>
        makeDraft({ filename: `ok-${i}.txt` }),
      ),
    ];
    const result = validateDrafts(drafts);
    // big.bin rejected for size; all MAX_ASSISTANT_ATTACHMENTS ok files accepted
    expect(result.accepted).toHaveLength(MAX_ASSISTANT_ATTACHMENTS);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain('big.bin');
  });

  test('returns empty accepted for empty input', () => {
    const result = validateDrafts([]);
    expect(result.accepted).toHaveLength(0);
    expect(result.warnings).toHaveLength(0);
  });
});
