/**
 * CSV/spreadsheet importer for bulk sequence enrollment.
 *
 * Parses CSV/TSV files, auto-detects columns, validates emails,
 * and bulk-enrolls contacts into a sequence.
 */

import { readFileSync } from "node:fs";
import { extname, resolve, sep } from "node:path";

import { getLogger } from "../util/logger.js";
import {
  checkCooldown,
  checkDuplicateEnrollment,
  checkEnrollmentCap,
} from "./guardrails.js";
import { enrollContact, getSequence } from "./store.js";

const log = getLogger("sequence:importer");

// ── Types ───────────────────────────────────────────────────────────

export interface ParsedContact {
  email: string;
  name?: string;
  context: Record<string, unknown>;
}

export interface ParseResult {
  contacts: ParsedContact[];
  errors: Array<{ row: number; reason: string }>;
  headers: string[];
}

export interface EnrollResult {
  enrolled: string[];
  skipped: Array<{ email: string; reason: string }>;
  failed: Array<{ email: string; reason: string }>;
}

// ── Path validation ─────────────────────────────────────────────────

const ALLOWED_IMPORT_EXTENSIONS = new Set([".csv", ".tsv"]);

function normalizeForPathCheck(path: string): string {
  return process.platform === "win32" ? path.toLowerCase() : path;
}

function validateImportPath(filePath: string): string {
  const resolvedPath = resolve(filePath);
  const workspaceRoot = resolve(process.cwd());
  const normalizedPath = normalizeForPathCheck(resolvedPath);
  const normalizedWorkspace = normalizeForPathCheck(workspaceRoot);

  if (
    normalizedPath !== normalizedWorkspace &&
    !normalizedPath.startsWith(`${normalizedWorkspace}${sep}`)
  ) {
    throw new Error("file_path must be inside the current workspace.");
  }

  const extension = extname(resolvedPath).toLowerCase();
  if (!ALLOWED_IMPORT_EXTENSIONS.has(extension)) {
    throw new Error("file_path must be a .csv or .tsv file.");
  }

  return resolvedPath;
}

// ── Email validation ────────────────────────────────────────────────

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function isValidEmail(email: string): boolean {
  return EMAIL_RE.test(email);
}

// ── Column detection ────────────────────────────────────────────────

// Alias lists are pre-normalized (same transform as normalizeHeader) so lookups
// match regardless of the original casing, spacing, or punctuation in the file.
const EMAIL_HEADERS = [
  "email",
  "e_mail",
  "email_address",
  "emailaddress",
  "mail",
];
const NAME_HEADERS = [
  "name",
  "full_name",
  "fullname",
  "display_name",
  "displayname",
];
const FIRST_NAME_HEADERS = ["first_name", "firstname", "first"];
const LAST_NAME_HEADERS = ["last_name", "lastname", "last"];

function normalizeHeader(h: string): string {
  return h
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_]/g, "_");
}

function detectColumns(headers: string[]): {
  emailIdx: number;
  nameIdx: number;
  firstNameIdx: number;
  lastNameIdx: number;
  contextIdxs: number[];
} {
  const normalized = headers.map(normalizeHeader);

  const emailIdx = normalized.findIndex((h) => EMAIL_HEADERS.includes(h));
  const nameIdx = normalized.findIndex((h) => NAME_HEADERS.includes(h));
  const firstNameIdx = normalized.findIndex((h) =>
    FIRST_NAME_HEADERS.includes(h),
  );
  const lastNameIdx = normalized.findIndex((h) =>
    LAST_NAME_HEADERS.includes(h),
  );

  const specialIdxs = new Set(
    [emailIdx, nameIdx, firstNameIdx, lastNameIdx].filter((i) => i >= 0),
  );
  const contextIdxs = headers
    .map((_, i) => i)
    .filter((i) => !specialIdxs.has(i));

  return { emailIdx, nameIdx, firstNameIdx, lastNameIdx, contextIdxs };
}

// ── CSV parsing ─────────────────────────────────────────────────────

function detectDelimiter(firstLine: string): string {
  if (firstLine.includes("\t")) return "\t";
  if (firstLine.includes(";")) return ";";
  return ",";
}

function parseCSVLine(line: string, delimiter: string): string[] {
  const fields: string[] = [];
  let current = "";
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"' && line[i + 1] === '"') {
        current += '"';
        i++;
      } else if (ch === '"') {
        inQuotes = false;
      } else {
        current += ch;
      }
    } else {
      if (ch === '"') {
        inQuotes = true;
      } else if (ch === delimiter) {
        fields.push(current.trim());
        current = "";
      } else {
        current += ch;
      }
    }
  }
  fields.push(current.trim());
  return fields;
}

/**
 * Split CSV text into rows while respecting quoted fields that contain newlines.
 * A newline inside a quoted field is part of the field value, not a row boundary.
 */
function splitCSVRows(content: string): string[] {
  const rows: string[] = [];
  let current = "";
  let inQuotes = false;

  for (let i = 0; i < content.length; i++) {
    const ch = content[i];
    if (inQuotes) {
      if (ch === '"') {
        if (content[i + 1] === '"') {
          // Escaped quote
          current += '""';
          i++;
        } else {
          inQuotes = false;
          current += ch;
        }
      } else {
        current += ch;
      }
    } else {
      if (ch === '"') {
        inQuotes = true;
        current += ch;
      } else if (ch === "\r" && content[i + 1] === "\n") {
        // CRLF row boundary
        if (current.trim().length > 0) rows.push(current);
        current = "";
        i++; // skip the \n
      } else if (ch === "\n") {
        // LF row boundary
        if (current.trim().length > 0) rows.push(current);
        current = "";
      } else {
        current += ch;
      }
    }
  }
  if (current.trim().length > 0) rows.push(current);
  return rows;
}

/**
 * Parse a CSV/TSV file into structured contacts.
 */
export function parseContactFile(filePath: string): ParseResult {
  const validatedPath = validateImportPath(filePath);
  const content = readFileSync(validatedPath, "utf-8");
  const lines = splitCSVRows(content);

  if (lines.length === 0) {
    return {
      contacts: [],
      errors: [{ row: 0, reason: "File is empty" }],
      headers: [],
    };
  }

  const delimiter = detectDelimiter(lines[0]);
  const firstRow = parseCSVLine(lines[0], delimiter);

  // Detect if first row is headers
  const hasHeaders = firstRow.some((f) =>
    EMAIL_HEADERS.includes(normalizeHeader(f)),
  );

  let headers: string[];
  let dataStartIdx: number;

  if (hasHeaders) {
    headers = firstRow;
    dataStartIdx = 1;
  } else {
    // No headers — assume col 1 = email, col 2 = name
    headers = [
      "email",
      "name",
      ...firstRow.slice(2).map((_, i) => `col_${i + 3}`),
    ];
    dataStartIdx = 0;
  }

  const { emailIdx, nameIdx, firstNameIdx, lastNameIdx, contextIdxs } =
    detectColumns(headers);
  const effectiveEmailIdx = emailIdx >= 0 ? emailIdx : 0;

  const contacts: ParsedContact[] = [];
  const errors: Array<{ row: number; reason: string }> = [];
  const seenEmails = new Set<string>();

  for (let i = dataStartIdx; i < lines.length; i++) {
    const fields = parseCSVLine(lines[i], delimiter);
    const rowNum = i + 1;

    const rawEmail = fields[effectiveEmailIdx]?.trim();
    if (!rawEmail) {
      errors.push({ row: rowNum, reason: "Missing email" });
      continue;
    }

    const email = rawEmail.toLowerCase();
    if (!isValidEmail(email)) {
      errors.push({ row: rowNum, reason: "Invalid email format" });
      continue;
    }

    if (seenEmails.has(email)) {
      errors.push({ row: rowNum, reason: `Duplicate email in file: ${email}` });
      continue;
    }
    seenEmails.add(email);

    // Build name
    let name: string | undefined;
    if (nameIdx >= 0) {
      name = fields[nameIdx]?.trim() || undefined;
    } else if (firstNameIdx >= 0) {
      const first = fields[firstNameIdx]?.trim() ?? "";
      const last = lastNameIdx >= 0 ? (fields[lastNameIdx]?.trim() ?? "") : "";
      name = [first, last].filter(Boolean).join(" ") || undefined;
    }

    // Build context from remaining columns
    const context: Record<string, unknown> = {};
    for (const idx of contextIdxs) {
      const val = fields[idx]?.trim();
      if (val) {
        context[normalizeHeader(headers[idx])] = val;
      }
    }

    contacts.push({ email, name, context });
  }

  return { contacts, errors, headers };
}

/**
 * Bulk-enroll parsed contacts into a sequence, respecting guardrails.
 */
export function bulkEnroll(
  sequenceId: string,
  contacts: ParsedContact[],
): EnrollResult {
  const seq = getSequence(sequenceId);
  if (!seq) throw new Error(`Sequence not found: ${sequenceId}`);

  const enrolled: string[] = [];
  const skipped: Array<{ email: string; reason: string }> = [];
  const failed: Array<{ email: string; reason: string }> = [];

  for (const contact of contacts) {
    // Pre-enrollment guardrails
    const capCheck = checkEnrollmentCap(sequenceId);
    if (!capCheck.ok) {
      skipped.push({ email: contact.email, reason: capCheck.reason });
      continue;
    }

    const dupCheck = checkDuplicateEnrollment(sequenceId, contact.email);
    if (!dupCheck.ok) {
      skipped.push({ email: contact.email, reason: dupCheck.reason });
      continue;
    }

    const cooldownCheck = checkCooldown(sequenceId, contact.email);
    if (!cooldownCheck.ok) {
      skipped.push({ email: contact.email, reason: cooldownCheck.reason });
      continue;
    }

    try {
      enrollContact({
        sequenceId,
        contactEmail: contact.email,
        contactName: contact.name,
        context:
          Object.keys(contact.context).length > 0 ? contact.context : undefined,
      });
      enrolled.push(contact.email);
    } catch (e) {
      const reason = e instanceof Error ? e.message : String(e);
      log.warn({ email: contact.email, err: e }, "Failed to enroll contact");
      failed.push({ email: contact.email, reason });
    }
  }

  return { enrolled, skipped, failed };
}
