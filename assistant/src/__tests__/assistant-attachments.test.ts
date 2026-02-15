import { describe, test, expect } from 'bun:test';
import {
  estimateBase64Bytes,
  inferMimeType,
  classifyKind,
  validateDrafts,
  cleanAssistantContent,
  contentBlocksToDrafts,
  deduplicateDrafts,
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

// ---------------------------------------------------------------------------
// cleanAssistantContent
// ---------------------------------------------------------------------------

describe('cleanAssistantContent', () => {
  test('strips directives from text blocks and returns them', () => {
    const content = [
      { type: 'text', text: 'Here is the file:\n<vellum-attachment path="out.png" />' },
    ];
    const result = cleanAssistantContent(content);

    expect(result.directives).toHaveLength(1);
    expect(result.directives[0].path).toBe('out.png');
    expect((result.cleanedContent[0] as { text: string }).text).toBe('Here is the file:');
  });

  test('leaves non-text blocks unchanged', () => {
    const content = [
      { type: 'tool_use', id: 't1', name: 'read', input: {} },
      { type: 'text', text: '<vellum-attachment path="x.pdf" />' },
    ];
    const result = cleanAssistantContent(content);

    expect(result.cleanedContent[0]).toEqual(content[0]);
    expect(result.directives).toHaveLength(1);
  });

  test('accumulates warnings for malformed tags', () => {
    const content = [
      { type: 'text', text: '<vellum-attachment source="bad" path="x.txt" />' },
    ];
    const result = cleanAssistantContent(content);

    expect(result.directives).toHaveLength(0);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain('invalid source');
  });

  test('handles content with no text blocks', () => {
    const content = [
      { type: 'thinking', thinking: 'hmm', signature: 'sig' },
    ];
    const result = cleanAssistantContent(content);

    expect(result.directives).toHaveLength(0);
    expect(result.warnings).toHaveLength(0);
    expect(result.cleanedContent).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// contentBlocksToDrafts
// ---------------------------------------------------------------------------

describe('contentBlocksToDrafts', () => {
  test('converts image content block to draft', () => {
    const blocks = [
      {
        type: 'image',
        source: { type: 'base64', media_type: 'image/png', data: 'iVBORw0K' },
      },
    ];
    const drafts = contentBlocksToDrafts(blocks);

    expect(drafts).toHaveLength(1);
    expect(drafts[0].sourceType).toBe('tool_block');
    expect(drafts[0].filename).toBe('tool-output.png');
    expect(drafts[0].mimeType).toBe('image/png');
    expect(drafts[0].kind).toBe('image');
  });

  test('converts file content block to draft', () => {
    const blocks = [
      {
        type: 'file',
        source: { type: 'base64', media_type: 'application/pdf', data: 'JVBER', filename: 'report.pdf' },
      },
    ];
    const drafts = contentBlocksToDrafts(blocks);

    expect(drafts).toHaveLength(1);
    expect(drafts[0].sourceType).toBe('tool_block');
    expect(drafts[0].filename).toBe('report.pdf');
    expect(drafts[0].kind).toBe('document');
  });

  test('skips non-image/file blocks', () => {
    const blocks = [
      { type: 'text', text: 'hello' },
      { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: '/9j/' } },
    ];
    const drafts = contentBlocksToDrafts(blocks);

    expect(drafts).toHaveLength(1);
    expect(drafts[0].mimeType).toBe('image/jpeg');
  });

  test('returns empty for empty input', () => {
    expect(contentBlocksToDrafts([])).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// deduplicateDrafts
// ---------------------------------------------------------------------------

describe('deduplicateDrafts', () => {
  test('removes duplicates by filename + content prefix', () => {
    const d = makeDraft({ filename: 'same.txt', dataBase64: 'AAAA'.repeat(20) });
    const result = deduplicateDrafts([d, { ...d }, makeDraft({ filename: 'other.txt' })]);

    expect(result).toHaveLength(2);
    expect(result[0].filename).toBe('same.txt');
    expect(result[1].filename).toBe('other.txt');
  });

  test('keeps drafts with same filename but different content', () => {
    const d1 = makeDraft({ filename: 'file.txt', dataBase64: 'AAAA'.repeat(20) });
    const d2 = makeDraft({ filename: 'file.txt', dataBase64: 'BBBB'.repeat(20) });
    const result = deduplicateDrafts([d1, d2]);

    expect(result).toHaveLength(2);
  });

  test('returns empty for empty input', () => {
    expect(deduplicateDrafts([])).toHaveLength(0);
  });
});
