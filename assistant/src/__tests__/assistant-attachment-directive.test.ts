import { describe, test, expect } from 'bun:test';
import { parseDirectives } from '../daemon/assistant-attachments.js';

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
