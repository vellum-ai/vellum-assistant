import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { join } from 'node:path';
import { mkdirSync, writeFileSync, rmSync, realpathSync } from 'node:fs';
import { parseDirectives, resolveSandboxDirective, resolveHostDirective, type DirectiveRequest } from '../daemon/assistant-attachments.js';

import { tmpdir } from 'node:os';

// Use realpath to avoid macOS /tmp → /private/tmp symlink mismatches
const RAW_TEST_DIR = join(tmpdir(), `vellum-sandbox-test-${Date.now()}`);
mkdirSync(RAW_TEST_DIR, { recursive: true });
const TEST_DIR = realpathSync(RAW_TEST_DIR);

// ---------------------------------------------------------------------------
// parseDirectives
// ---------------------------------------------------------------------------

describe('parseDirectives', () => {
  test('parses a single sandbox directive with all attributes', () => {
    const text = 'Here is the report:\n<vellum-attachment source="sandbox" path="output/report.pdf" filename="report.pdf" mime_type="application/pdf" />';
    const result = parseDirectives(text);

    expect(result.directiveRequests).toHaveLength(1);
    expect(result.directiveRequests[0]).toEqual({
      source: 'sandbox',
      path: 'output/report.pdf',
      filename: 'report.pdf',
      mimeType: 'application/pdf',
    });
    expect(result.cleanText).toBe('Here is the report:');
    expect(result.parseWarnings).toHaveLength(0);
  });

  test('defaults source to sandbox when omitted', () => {
    const text = '<vellum-attachment path="chart.png" />';
    const result = parseDirectives(text);

    expect(result.directiveRequests).toHaveLength(1);
    expect(result.directiveRequests[0].source).toBe('sandbox');
  });

  test('parses host source', () => {
    const text = '<vellum-attachment source="host" path="/Users/me/doc.pdf" />';
    const result = parseDirectives(text);

    expect(result.directiveRequests).toHaveLength(1);
    expect(result.directiveRequests[0].source).toBe('host');
    expect(result.directiveRequests[0].path).toBe('/Users/me/doc.pdf');
  });

  test('leaves optional filename and mime_type undefined when absent', () => {
    const text = '<vellum-attachment path="file.txt" />';
    const result = parseDirectives(text);

    expect(result.directiveRequests[0].filename).toBeUndefined();
    expect(result.directiveRequests[0].mimeType).toBeUndefined();
  });

  test('parses multiple directives preserving order', () => {
    const text = [
      'Results:',
      '<vellum-attachment path="a.png" />',
      'And also:',
      '<vellum-attachment path="b.pdf" />',
    ].join('\n');

    const result = parseDirectives(text);

    expect(result.directiveRequests).toHaveLength(2);
    expect(result.directiveRequests[0].path).toBe('a.png');
    expect(result.directiveRequests[1].path).toBe('b.pdf');
    expect(result.cleanText).toBe('Results:\n\nAnd also:');
  });

  test('rejects directive without path attribute', () => {
    const text = '<vellum-attachment source="sandbox" />';
    const result = parseDirectives(text);

    expect(result.directiveRequests).toHaveLength(0);
    expect(result.parseWarnings).toHaveLength(1);
    expect(result.parseWarnings[0]).toContain('missing required "path"');
    // Malformed tag preserved in text
    expect(result.cleanText).toContain('<vellum-attachment');
  });

  test('rejects directive with invalid source value', () => {
    const text = '<vellum-attachment source="cloud" path="x.txt" />';
    const result = parseDirectives(text);

    expect(result.directiveRequests).toHaveLength(0);
    expect(result.parseWarnings).toHaveLength(1);
    expect(result.parseWarnings[0]).toContain('invalid source="cloud"');
    expect(result.cleanText).toContain('<vellum-attachment');
  });

  test('handles mixed valid and invalid directives', () => {
    const text = [
      '<vellum-attachment path="good.png" />',
      '<vellum-attachment source="nope" path="bad.txt" />',
      '<vellum-attachment path="also-good.pdf" />',
    ].join('\n');

    const result = parseDirectives(text);

    expect(result.directiveRequests).toHaveLength(2);
    expect(result.directiveRequests[0].path).toBe('good.png');
    expect(result.directiveRequests[1].path).toBe('also-good.pdf');
    expect(result.parseWarnings).toHaveLength(1);
  });

  test('returns original text when no directives present', () => {
    const text = 'Hello world, no attachments here.';
    const result = parseDirectives(text);

    expect(result.cleanText).toBe(text);
    expect(result.directiveRequests).toHaveLength(0);
    expect(result.parseWarnings).toHaveLength(0);
  });

  test('preserves non-self-closing tags as plain text', () => {
    const text = '<vellum-attachment path="file.txt">content</vellum-attachment>';
    const result = parseDirectives(text);

    // The regex only matches self-closing tags, so non-self-closing is not matched
    expect(result.directiveRequests).toHaveLength(0);
    expect(result.cleanText).toContain('content</vellum-attachment>');
  });

  test('handles single-quoted attributes', () => {
    const text = "<vellum-attachment path='report.pdf' filename='my report.pdf' />";
    const result = parseDirectives(text);

    expect(result.directiveRequests).toHaveLength(1);
    expect(result.directiveRequests[0].path).toBe('report.pdf');
    expect(result.directiveRequests[0].filename).toBe('my report.pdf');
  });

  test('collapses excess blank lines after tag removal', () => {
    const text = 'Before\n\n<vellum-attachment path="x.png" />\n\n\nAfter';
    const result = parseDirectives(text);

    // Should not have triple+ newlines
    expect(result.cleanText).not.toMatch(/\n{3,}/);
    expect(result.cleanText).toBe('Before\n\nAfter');
  });

  test('handles directive with multiline attributes', () => {
    const text = [
      '<vellum-attachment',
      '  source="host"',
      '  path="/tmp/data.csv"',
      '  mime_type="text/csv"',
      '/>',
    ].join('\n');
    const result = parseDirectives(text);

    expect(result.directiveRequests).toHaveLength(1);
    expect(result.directiveRequests[0].source).toBe('host');
    expect(result.directiveRequests[0].path).toBe('/tmp/data.csv');
    expect(result.directiveRequests[0].mimeType).toBe('text/csv');
  });
});

// ---------------------------------------------------------------------------
// resolveSandboxDirective
// ---------------------------------------------------------------------------

describe('resolveSandboxDirective', () => {
  beforeEach(() => {
    mkdirSync(join(TEST_DIR, 'sub'), { recursive: true });
  });

  afterEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
  });

  function makeDirective(overrides: Partial<DirectiveRequest> = {}): DirectiveRequest {
    return {
      source: 'sandbox',
      path: 'hello.txt',
      filename: undefined,
      mimeType: undefined,
      ...overrides,
    };
  }

  test('resolves a valid sandbox file to a draft', () => {
    const filePath = join(TEST_DIR, 'hello.txt');
    writeFileSync(filePath, 'hello world');

    const result = resolveSandboxDirective(makeDirective({ path: 'hello.txt' }), TEST_DIR);

    expect(result.draft).not.toBeNull();
    expect(result.warning).toBeNull();
    expect(result.draft!.sourceType).toBe('sandbox_file');
    expect(result.draft!.filename).toBe('hello.txt');
    expect(result.draft!.mimeType).toBe('text/plain');
    expect(result.draft!.sizeBytes).toBe(11);
    expect(result.draft!.kind).toBe('document');
  });

  test('uses directive filename override when provided', () => {
    writeFileSync(join(TEST_DIR, 'data.txt'), 'content');

    const result = resolveSandboxDirective(
      makeDirective({ path: 'data.txt', filename: 'custom-name.txt' }),
      TEST_DIR,
    );

    expect(result.draft!.filename).toBe('custom-name.txt');
  });

  test('uses directive mimeType override when provided', () => {
    writeFileSync(join(TEST_DIR, 'data.bin'), Buffer.from([1, 2, 3]));

    const result = resolveSandboxDirective(
      makeDirective({ path: 'data.bin', mimeType: 'application/x-custom' }),
      TEST_DIR,
    );

    expect(result.draft!.mimeType).toBe('application/x-custom');
  });

  test('infers MIME type from extension', () => {
    writeFileSync(join(TEST_DIR, 'image.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));

    const result = resolveSandboxDirective(makeDirective({ path: 'image.png' }), TEST_DIR);

    expect(result.draft!.mimeType).toBe('image/png');
    expect(result.draft!.kind).toBe('image');
  });

  test('rejects paths that escape sandbox boundary', () => {
    const result = resolveSandboxDirective(makeDirective({ path: '../../etc/passwd' }), TEST_DIR);

    expect(result.draft).toBeNull();
    expect(result.warning).toContain('outside the working directory');
  });

  test('warns when file does not exist', () => {
    const result = resolveSandboxDirective(makeDirective({ path: 'nonexistent.txt' }), TEST_DIR);

    expect(result.draft).toBeNull();
    expect(result.warning).toContain('file not found');
  });

  test('warns when path is a directory', () => {
    const result = resolveSandboxDirective(makeDirective({ path: 'sub' }), TEST_DIR);

    expect(result.draft).toBeNull();
    expect(result.warning).toContain('not a regular file');
  });

  test('resolves relative subdirectory paths', () => {
    writeFileSync(join(TEST_DIR, 'sub', 'nested.json'), '{"key":"value"}');

    const result = resolveSandboxDirective(makeDirective({ path: 'sub/nested.json' }), TEST_DIR);

    expect(result.draft).not.toBeNull();
    expect(result.draft!.filename).toBe('nested.json');
    expect(result.draft!.mimeType).toBe('application/json');
  });

  test('base64 encodes file content correctly', () => {
    const content = 'test content';
    writeFileSync(join(TEST_DIR, 'test.txt'), content);

    const result = resolveSandboxDirective(makeDirective({ path: 'test.txt' }), TEST_DIR);

    expect(result.draft).not.toBeNull();
    const decoded = Buffer.from(result.draft!.dataBase64, 'base64').toString('utf-8');
    expect(decoded).toBe(content);
  });
});

// ---------------------------------------------------------------------------
// resolveHostDirective
// ---------------------------------------------------------------------------

describe('resolveHostDirective', () => {
  beforeEach(() => {
    mkdirSync(join(TEST_DIR, 'host-sub'), { recursive: true });
  });

  afterEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
  });

  function makeHostDirective(overrides: Partial<DirectiveRequest> = {}): DirectiveRequest {
    return {
      source: 'host',
      path: join(TEST_DIR, 'doc.txt'),
      filename: undefined,
      mimeType: undefined,
      ...overrides,
    };
  }

  const alwaysApprove = async () => true;
  const alwaysDeny = async () => false;

  test('resolves an approved host file to a draft', async () => {
    const filePath = join(TEST_DIR, 'doc.txt');
    writeFileSync(filePath, 'host content');

    const result = await resolveHostDirective(makeHostDirective(), alwaysApprove);

    expect(result.draft).not.toBeNull();
    expect(result.warning).toBeNull();
    expect(result.draft!.sourceType).toBe('host_file');
    expect(result.draft!.filename).toBe('doc.txt');
    expect(result.draft!.mimeType).toBe('text/plain');
    expect(result.draft!.sizeBytes).toBe(12);
  });

  test('skips when user denies', async () => {
    writeFileSync(join(TEST_DIR, 'secret.txt'), 'private');

    const result = await resolveHostDirective(
      makeHostDirective({ path: join(TEST_DIR, 'secret.txt') }),
      alwaysDeny,
    );

    expect(result.draft).toBeNull();
    expect(result.warning).toContain('access denied by user');
  });

  test('rejects relative paths', async () => {
    const result = await resolveHostDirective(
      makeHostDirective({ path: 'relative/path.txt' }),
      alwaysApprove,
    );

    expect(result.draft).toBeNull();
    expect(result.warning).toContain('must be absolute');
  });

  test('warns when file does not exist', async () => {
    const result = await resolveHostDirective(
      makeHostDirective({ path: join(TEST_DIR, 'nonexistent.txt') }),
      alwaysApprove,
    );

    expect(result.draft).toBeNull();
    expect(result.warning).toContain('file not found');
  });

  test('warns when path is a directory', async () => {
    const result = await resolveHostDirective(
      makeHostDirective({ path: join(TEST_DIR, 'host-sub') }),
      alwaysApprove,
    );

    expect(result.draft).toBeNull();
    expect(result.warning).toContain('not a regular file');
  });

  test('uses directive filename and mimeType overrides', async () => {
    writeFileSync(join(TEST_DIR, 'data.bin'), Buffer.from([1, 2, 3]));

    const result = await resolveHostDirective(
      makeHostDirective({
        path: join(TEST_DIR, 'data.bin'),
        filename: 'custom.dat',
        mimeType: 'application/x-custom',
      }),
      alwaysApprove,
    );

    expect(result.draft!.filename).toBe('custom.dat');
    expect(result.draft!.mimeType).toBe('application/x-custom');
  });

  test('handles approval callback error gracefully', async () => {
    writeFileSync(join(TEST_DIR, 'doc.txt'), 'content');

    const failApprove = async () => { throw new Error('IPC disconnected'); };
    const result = await resolveHostDirective(makeHostDirective(), failApprove);

    expect(result.draft).toBeNull();
    expect(result.warning).toContain('approval request failed');
  });

  test('calls approve with the resolved absolute path', async () => {
    writeFileSync(join(TEST_DIR, 'doc.txt'), 'content');

    let approvedPath = '';
    const captureApprove = async (p: string) => { approvedPath = p; return true; };

    await resolveHostDirective(makeHostDirective(), captureApprove);

    expect(approvedPath).toBe(join(TEST_DIR, 'doc.txt'));
  });
});
