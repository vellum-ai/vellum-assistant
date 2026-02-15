/**
 * Assistant outbound attachment types and helpers.
 *
 * Shared DTOs and utilities for building attachment candidates from
 * directives, tool content blocks, and file reads.
 */

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Maximum number of attachments the assistant may emit per turn. */
export const MAX_ASSISTANT_ATTACHMENTS = 5;

/** Maximum size in bytes for a single assistant attachment (20 MB). */
export const MAX_ASSISTANT_ATTACHMENT_BYTES = 20 * 1024 * 1024;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type AttachmentSourceType = 'sandbox_file' | 'host_file' | 'tool_block';

export interface AssistantAttachmentDraft {
  sourceType: AttachmentSourceType;
  filename: string;
  mimeType: string;
  dataBase64: string;
  sizeBytes: number;
  kind: 'image' | 'document';
}

// ---------------------------------------------------------------------------
// Base64 size estimation
// ---------------------------------------------------------------------------

/**
 * Estimate the decoded byte length of a base64-encoded string.
 * Accounts for trailing `=` padding characters.
 */
export function estimateBase64Bytes(base64: string): number {
  const padding = base64.endsWith('==') ? 2 : base64.endsWith('=') ? 1 : 0;
  return Math.max(0, Math.floor((base64.length * 3) / 4) - padding);
}

// ---------------------------------------------------------------------------
// MIME inference
// ---------------------------------------------------------------------------

const EXTENSION_MIME_MAP: Record<string, string> = {
  // Images
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
  ico: 'image/x-icon',
  bmp: 'image/bmp',

  // Documents
  pdf: 'application/pdf',
  json: 'application/json',
  xml: 'application/xml',
  csv: 'text/csv',
  txt: 'text/plain',
  md: 'text/markdown',
  html: 'text/html',
  css: 'text/css',
  js: 'text/javascript',
  ts: 'text/typescript',

  // Archives
  zip: 'application/zip',
  gz: 'application/gzip',
  tar: 'application/x-tar',
};

/**
 * Infer a MIME type from a filename extension.
 * Returns `application/octet-stream` when the extension is unrecognised.
 */
export function inferMimeType(filename: string): string {
  const dot = filename.lastIndexOf('.');
  if (dot === -1) return 'application/octet-stream';
  const ext = filename.slice(dot + 1).toLowerCase();
  return EXTENSION_MIME_MAP[ext] ?? 'application/octet-stream';
}

// ---------------------------------------------------------------------------
// Kind classification
// ---------------------------------------------------------------------------

export function classifyKind(mimeType: string): 'image' | 'document' {
  return mimeType.startsWith('image/') ? 'image' : 'document';
}

// ---------------------------------------------------------------------------
// Validation / cap enforcement
// ---------------------------------------------------------------------------

export interface ValidatedDrafts {
  accepted: AssistantAttachmentDraft[];
  warnings: string[];
}

/**
 * Enforce per-turn attachment caps.
 *
 * - Rejects individual drafts that exceed `MAX_ASSISTANT_ATTACHMENT_BYTES`.
 * - Truncates the list at `MAX_ASSISTANT_ATTACHMENTS`.
 */
export function validateDrafts(drafts: AssistantAttachmentDraft[]): ValidatedDrafts {
  const accepted: AssistantAttachmentDraft[] = [];
  const warnings: string[] = [];

  for (const draft of drafts) {
    if (draft.sizeBytes > MAX_ASSISTANT_ATTACHMENT_BYTES) {
      warnings.push(
        `Skipped attachment "${draft.filename}": ` +
        `size ${formatBytes(draft.sizeBytes)} exceeds ${formatBytes(MAX_ASSISTANT_ATTACHMENT_BYTES)} limit.`,
      );
      continue;
    }

    if (accepted.length >= MAX_ASSISTANT_ATTACHMENTS) {
      warnings.push(
        `Skipped attachment "${draft.filename}": ` +
        `exceeded maximum of ${MAX_ASSISTANT_ATTACHMENTS} attachments per turn.`,
      );
      continue;
    }

    accepted.push(draft);
  }

  return { accepted, warnings };
}

// ---------------------------------------------------------------------------
// Directive parser
// ---------------------------------------------------------------------------

export type DirectiveSource = 'sandbox' | 'host';

export interface DirectiveRequest {
  source: DirectiveSource;
  path: string;
  filename: string | undefined;
  mimeType: string | undefined;
}

export interface DirectiveParseResult {
  cleanText: string;
  directiveRequests: DirectiveRequest[];
  parseWarnings: string[];
}

/**
 * Match self-closing `<vellum-attachment ... />` tags.
 *
 * Captures the attribute string between the tag name and the `/>` close.
 * Non-greedy so multiple tags on separate lines are matched individually.
 */
const DIRECTIVE_RE = /<vellum-attachment\s+([\s\S]*?)\/>/g;

/**
 * Parse individual attribute key="value" pairs.
 * Supports both double and single quotes.
 */
const ATTR_RE = /(\w+)\s*=\s*"([^"]*)"|(\w+)\s*=\s*'([^']*)'/g;

function parseAttributes(raw: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  let m: RegExpExecArray | null;
  while ((m = ATTR_RE.exec(raw)) !== null) {
    const key = m[1] ?? m[3];
    const value = m[2] ?? m[4];
    attrs[key] = value;
  }
  return attrs;
}

/**
 * Scan assistant text for `<vellum-attachment ... />` directives.
 *
 * Returns the text with successfully parsed directives stripped,
 * along with the parsed directive requests and any warnings for
 * malformed tags.
 */
export function parseDirectives(text: string): DirectiveParseResult {
  const directiveRequests: DirectiveRequest[] = [];
  const parseWarnings: string[] = [];

  const cleanText = text.replace(DIRECTIVE_RE, (fullMatch, attrStr: string) => {
    const attrs = parseAttributes(attrStr);

    if (!attrs['path']) {
      parseWarnings.push('Ignored <vellum-attachment />: missing required "path" attribute.');
      return fullMatch;
    }

    const sourceRaw = attrs['source'] ?? 'sandbox';
    if (sourceRaw !== 'sandbox' && sourceRaw !== 'host') {
      parseWarnings.push(
        `Ignored <vellum-attachment />: invalid source="${sourceRaw}". Must be "sandbox" or "host".`,
      );
      return fullMatch;
    }

    directiveRequests.push({
      source: sourceRaw,
      path: attrs['path'],
      filename: attrs['filename'] || undefined,
      mimeType: attrs['mime_type'] || undefined,
    });

    return '';
  });

  return {
    cleanText: cleanText.replace(/\n{3,}/g, '\n\n').trim(),
    directiveRequests,
    parseWarnings,
  };
}

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
