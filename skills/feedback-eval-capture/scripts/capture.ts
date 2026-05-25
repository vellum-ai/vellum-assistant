#!/usr/bin/env bun

/**
 * Feedback → eval capture tool.
 *
 * Reads a `vellum-export-*.tar.gz` produced by the assistant's
 * `POST /v1/export` route, locates a conversation inside, and either
 *
 *   - lists what's in the tar (`inspect`)
 *   - prints the conversation as a numbered timeline (`messages`)
 *   - writes a deterministic eval case to disk (`capture`)
 *
 * The skill (`SKILL.md`) drives a short developer interview. This script
 * does the deterministic file shuffling.
 *
 * Usage:
 *   bun run scripts/capture.ts inspect  --tar <path>
 *   bun run scripts/capture.ts messages --tar <path> [--conversation-id <id>]
 *   bun run scripts/capture.ts capture  --tar <path> [--conversation-id <id>]
 *                                       --failure-index <n>
 *                                       --expected <text>
 *                                       [--notes <text>] [--name <slug>] [--out <dir>]
 */

import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { parseArgs } from "node:util";

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

interface MessageRecord {
  role: string;
  ts?: string;
  content?: string;
  toolCalls?: Array<{ name: string; input?: unknown }>;
  toolResults?: Array<{ content?: unknown }>;
  attachments?: string[];
  metadata?: Record<string, unknown>;
}

interface ConversationMeta {
  id: string;
  title: string | null;
  type: string;
  channel: string | null;
  createdAt: string;
  updatedAt: string;
}

interface ExportManifest {
  type: string;
  conversationId?: string;
  full?: boolean;
  assistantVersion?: string;
  commitSha?: string;
  startTime?: number;
  endTime?: number;
  exportedAt?: string;
}

interface ExtractedTar {
  /** Absolute path of the temp dir the tar was extracted into. */
  root: string;
  /** Parsed `export-manifest.json` (or `null` if absent). */
  manifest: ExportManifest | null;
  /** Conversation directory names that exist under `workspace/conversations/`. */
  conversationDirs: string[];
}

/**
 * Extract a tar.gz to a fresh temp directory.
 *
 * Uses the system `tar` binary (same one `createTarGz` uses on the producer
 * side) so the wire format stays in lockstep. We pass `-z` for gzip and
 * `-x` for extract; the absolute output dir is passed via `-C` so the tar
 * can never write outside the temp directory we created.
 */
function extractTarball(tarPath: string): ExtractedTar {
  const absTar = resolve(tarPath);
  if (!existsSync(absTar)) {
    throw new Error(`Tarball not found: ${absTar}`);
  }
  const stat = statSync(absTar);
  if (!stat.isFile()) {
    throw new Error(`Tar path is not a regular file: ${absTar}`);
  }

  const stagingDir = mkdtempSync(join(tmpdir(), "feedback-eval-"));

  const result = spawnSync(
    "tar",
    ["-xzf", absTar, "-C", stagingDir],
    { stdio: ["ignore", "pipe", "pipe"], timeout: 30_000 },
  );
  if (result.status !== 0) {
    const stderr = result.stderr?.toString("utf-8") ?? "(no stderr)";
    rmSync(stagingDir, { recursive: true, force: true });
    throw new Error(`tar extraction failed: ${stderr.trim()}`);
  }

  const manifestPath = join(stagingDir, "export-manifest.json");
  let manifest: ExportManifest | null = null;
  if (existsSync(manifestPath)) {
    try {
      manifest = JSON.parse(
        readFileSync(manifestPath, "utf-8"),
      ) as ExportManifest;
    } catch {
      manifest = null;
    }
  }

  const conversationsRoot = join(stagingDir, "workspace", "conversations");
  let conversationDirs: string[] = [];
  if (existsSync(conversationsRoot)) {
    conversationDirs = readdirSync(conversationsRoot)
      .filter((name) => {
        try {
          return statSync(join(conversationsRoot, name)).isDirectory();
        } catch {
          return false;
        }
      })
      .sort();
  }

  return { root: stagingDir, manifest, conversationDirs };
}

/**
 * Pull the conversationId out of a directory name shaped like
 * `2026-05-19T06-39-06.840Z_25b6f81c-3dc1-418a-a919-829bc6a31d2e`.
 * Returns null if the name doesn't match.
 */
function conversationIdFromDirName(name: string): string | null {
  const idx = name.indexOf("_");
  if (idx < 0) return null;
  const id = name.slice(idx + 1);
  return id.length > 0 ? id : null;
}

function readConversationMessages(conversationDir: string): MessageRecord[] {
  const messagesPath = join(conversationDir, "messages.jsonl");
  if (!existsSync(messagesPath)) {
    throw new Error(`messages.jsonl missing under ${conversationDir}`);
  }
  const raw = readFileSync(messagesPath, "utf-8");
  const records: MessageRecord[] = [];
  let lineNum = 0;
  for (const rawLine of raw.split("\n")) {
    lineNum++;
    const line = rawLine.trim();
    if (!line) continue;
    let parsed: MessageRecord;
    try {
      parsed = JSON.parse(line) as MessageRecord;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(
        `messages.jsonl line ${lineNum} is not valid JSON: ${msg}`,
      );
    }
    records.push(parsed);
  }
  return records;
}

function readConversationMeta(conversationDir: string): ConversationMeta | null {
  const metaPath = join(conversationDir, "meta.json");
  if (!existsSync(metaPath)) return null;
  try {
    return JSON.parse(readFileSync(metaPath, "utf-8")) as ConversationMeta;
  } catch {
    return null;
  }
}

/**
 * Resolve the conversation directory inside an extracted tar.
 *
 * If `conversationId` is provided, find the directory whose name suffix
 * matches. Otherwise, error when there are zero or >1 conversations so
 * the caller is forced to disambiguate.
 */
function resolveConversationDir(
  extracted: ExtractedTar,
  conversationId: string | undefined,
): { dirName: string; absPath: string; id: string } {
  const root = join(extracted.root, "workspace", "conversations");
  if (extracted.conversationDirs.length === 0) {
    throw new Error(
      "Tar has no workspace/conversations/ entries. " +
        "Was this a global export rather than a per-conversation export?",
    );
  }

  if (conversationId) {
    const match = extracted.conversationDirs.find(
      (name) => conversationIdFromDirName(name) === conversationId,
    );
    if (!match) {
      throw new Error(
        `Tar does not contain conversation ${conversationId}. ` +
          `Found: ${extracted.conversationDirs.join(", ")}`,
      );
    }
    return {
      dirName: match,
      absPath: join(root, match),
      id: conversationId,
    };
  }

  if (extracted.conversationDirs.length > 1) {
    const ids = extracted.conversationDirs
      .map(conversationIdFromDirName)
      .filter((x): x is string => x !== null);
    throw new Error(
      `Tar contains ${extracted.conversationDirs.length} conversations; ` +
        `pass --conversation-id to choose. Available: ${ids.join(", ")}`,
    );
  }

  const onlyDir = extracted.conversationDirs[0];
  const id = conversationIdFromDirName(onlyDir);
  if (!id) {
    throw new Error(
      `Conversation directory has non-canonical name: ${onlyDir}`,
    );
  }
  return { dirName: onlyDir, absPath: join(root, onlyDir), id };
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return text.slice(0, max - 1) + "…";
}

function previewMessageContent(rec: MessageRecord): string {
  if (rec.content && rec.content.trim().length > 0) {
    return truncate(rec.content.replace(/\s+/g, " ").trim(), 140);
  }
  if (rec.toolCalls && rec.toolCalls.length > 0) {
    const names = rec.toolCalls.map((c) => c.name).join(", ");
    return `<tool_use: ${names}>`;
  }
  if (rec.toolResults && rec.toolResults.length > 0) {
    return `<tool_result × ${rec.toolResults.length}>`;
  }
  return "<empty>";
}

/**
 * Stable JSON encode: keys sorted alphabetically at every depth so byte-equal
 * inputs produce byte-equal outputs.
 */
function stableStringify(value: unknown, indent = 2): string {
  return JSON.stringify(value, sortedReplacer, indent) + "\n";
}

function sortedReplacer(_key: string, value: unknown): unknown {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const obj = value as Record<string, unknown>;
    const sorted: Record<string, unknown> = {};
    for (const k of Object.keys(obj).sort()) {
      sorted[k] = obj[k];
    }
    return sorted;
  }
  return value;
}

function getEvalsRoot(): string {
  const override = process.env.VELLUM_WORKSPACE_DIR;
  if (override && override.trim().length > 0) {
    return join(override, "evals");
  }
  return join(homedir(), ".vellum", "workspace", "evals");
}

function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
}

// ---------------------------------------------------------------------------
// `inspect` subcommand
// ---------------------------------------------------------------------------

interface InspectConversationSummary {
  dirName: string;
  conversationId: string | null;
  meta: ConversationMeta | null;
  messageCount: number;
  firstUserMessage: string | null;
}

interface InspectOutput {
  tar: string;
  manifest: ExportManifest | null;
  conversations: InspectConversationSummary[];
}

function runInspect(opts: { tar: string }): void {
  const extracted = extractTarball(opts.tar);
  try {
    const conversations: InspectConversationSummary[] = [];
    for (const dirName of extracted.conversationDirs) {
      const absPath = join(
        extracted.root,
        "workspace",
        "conversations",
        dirName,
      );
      let messages: MessageRecord[] = [];
      try {
        messages = readConversationMessages(absPath);
      } catch {
        // No messages.jsonl is recorded; reported as messageCount=0.
      }
      const firstUser = messages.find((m) => m.role === "user");
      conversations.push({
        dirName,
        conversationId: conversationIdFromDirName(dirName),
        meta: readConversationMeta(absPath),
        messageCount: messages.length,
        firstUserMessage: firstUser ? previewMessageContent(firstUser) : null,
      });
    }
    const out: InspectOutput = {
      tar: resolve(opts.tar),
      manifest: extracted.manifest,
      conversations,
    };
    process.stdout.write(stableStringify(out));
  } finally {
    rmSync(extracted.root, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// `messages` subcommand
// ---------------------------------------------------------------------------

interface MessagesTimelineEntry {
  index: number;
  role: string;
  ts: string | null;
  preview: string;
  toolCalls: string[];
  hasToolResults: boolean;
  attachments: string[];
}

interface MessagesOutput {
  tar: string;
  conversationId: string;
  conversationDir: string;
  messageCount: number;
  timeline: MessagesTimelineEntry[];
}

function runMessages(opts: { tar: string; conversationId?: string }): void {
  const extracted = extractTarball(opts.tar);
  try {
    const { dirName, absPath, id } = resolveConversationDir(
      extracted,
      opts.conversationId,
    );
    const messages = readConversationMessages(absPath);
    const timeline: MessagesTimelineEntry[] = messages.map((rec, index) => ({
      index,
      role: rec.role,
      ts: rec.ts ?? null,
      preview: previewMessageContent(rec),
      toolCalls: rec.toolCalls?.map((c) => c.name) ?? [],
      hasToolResults: (rec.toolResults?.length ?? 0) > 0,
      attachments: rec.attachments ?? [],
    }));
    const out: MessagesOutput = {
      tar: resolve(opts.tar),
      conversationId: id,
      conversationDir: dirName,
      messageCount: messages.length,
      timeline,
    };
    process.stdout.write(stableStringify(out));
  } finally {
    rmSync(extracted.root, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// `capture` subcommand
// ---------------------------------------------------------------------------

interface CaptureOpts {
  tar: string;
  conversationId?: string;
  failureIndex: number;
  expected: string;
  notes?: string;
  name?: string;
  out?: string;
}

interface CaseFile {
  schemaVersion: 1;
  slug: string;
  createdAt: string;
  source: {
    tarPath: string;
    conversationId: string;
    conversationDir: string;
    exportManifest: ExportManifest | null;
    conversationMeta: ConversationMeta | null;
  };
  failure: {
    messageIndex: number;
    expectedBehavior: string;
  };
  prefix: {
    messageCount: number;
    lastUserMessageIndex: number | null;
    messagesFile: "messages.jsonl";
    attachmentsDir: "attachments";
    missingAttachments: string[];
  };
}

interface CaptureOutput {
  slug: string;
  outDir: string;
  prefixMessageCount: number;
  failureMessageIndex: number;
  attachmentsCopied: number;
  missingAttachments: string[];
}

function runCapture(opts: CaptureOpts): void {
  if (!Number.isInteger(opts.failureIndex) || opts.failureIndex < 0) {
    throw new Error(
      `--failure-index must be a non-negative integer, got ${opts.failureIndex}`,
    );
  }
  if (!opts.expected || opts.expected.trim().length === 0) {
    throw new Error("--expected is required and must be non-empty");
  }

  const extracted = extractTarball(opts.tar);
  try {
    const { dirName, absPath, id } = resolveConversationDir(
      extracted,
      opts.conversationId,
    );
    const messages = readConversationMessages(absPath);

    if (opts.failureIndex >= messages.length) {
      throw new Error(
        `--failure-index ${opts.failureIndex} is out of range; ` +
          `conversation has ${messages.length} messages (max index ${messages.length - 1})`,
      );
    }

    const prefix = messages.slice(0, opts.failureIndex);
    const failingTurn = messages[opts.failureIndex];

    const slug = opts.name ?? defaultSlug(id, failingTurn);
    const evalsRoot = opts.out ? resolve(opts.out) : getEvalsRoot();
    const caseDir = join(evalsRoot, slug);

    // Atomic overwrite — wipe any prior contents so re-runs are deterministic.
    if (existsSync(caseDir)) {
      rmSync(caseDir, { recursive: true, force: true });
    }
    mkdirSync(caseDir, { recursive: true });

    // Copy attachments referenced by prefix rows (and only those).
    const attachmentsSrc = join(absPath, "attachments");
    const attachmentsDst = join(caseDir, "attachments");
    const missingAttachments: string[] = [];
    let attachmentsCopied = 0;
    const referenced = new Set<string>();
    for (const rec of prefix) {
      for (const name of rec.attachments ?? []) referenced.add(name);
    }
    if (referenced.size > 0) {
      mkdirSync(attachmentsDst, { recursive: true });
      for (const name of [...referenced].sort()) {
        const src = join(attachmentsSrc, name);
        if (!existsSync(src)) {
          missingAttachments.push(name);
          continue;
        }
        cpSync(src, join(attachmentsDst, name));
        attachmentsCopied++;
      }
    }

    // Write messages.jsonl prefix verbatim (re-serialize each row with stable
    // key ordering so the output is byte-stable but still one JSON per line).
    const prefixLines = prefix
      .map((rec) => JSON.stringify(rec, sortedReplacer))
      .join("\n");
    writeFileSync(
      join(caseDir, "messages.jsonl"),
      prefix.length > 0 ? prefixLines + "\n" : "",
      "utf-8",
    );

    // Write failing-turn.json verbatim.
    writeFileSync(
      join(caseDir, "failing-turn.json"),
      stableStringify(failingTurn),
      "utf-8",
    );

    // Copy source metadata so the case is self-describing without needing
    // the original tarball.
    const sourceDir = join(caseDir, "source");
    mkdirSync(sourceDir, { recursive: true });
    if (extracted.manifest) {
      writeFileSync(
        join(sourceDir, "export-manifest.json"),
        stableStringify(extracted.manifest),
        "utf-8",
      );
    }
    const meta = readConversationMeta(absPath);
    if (meta) {
      writeFileSync(
        join(sourceDir, "meta.json"),
        stableStringify(meta),
        "utf-8",
      );
    }

    // case.json — the structured contract for the future runner.
    const caseFile: CaseFile = {
      schemaVersion: 1,
      slug,
      createdAt: new Date().toISOString(),
      source: {
        tarPath: resolve(opts.tar),
        conversationId: id,
        conversationDir: dirName,
        exportManifest: extracted.manifest,
        conversationMeta: meta,
      },
      failure: {
        messageIndex: opts.failureIndex,
        expectedBehavior: opts.expected.trim(),
      },
      prefix: {
        messageCount: prefix.length,
        lastUserMessageIndex: lastIndexWhere(prefix, (m) => m.role === "user"),
        messagesFile: "messages.jsonl",
        attachmentsDir: "attachments",
        missingAttachments,
      },
    };
    writeFileSync(
      join(caseDir, "case.json"),
      stableStringify(caseFile),
      "utf-8",
    );

    // notes.md — developer-facing freeform notes seeded with the expected
    // behavior so the file is always useful, even when --notes is omitted.
    const notesBody = renderNotesMarkdown(caseFile, opts.notes);
    writeFileSync(join(caseDir, "notes.md"), notesBody, "utf-8");

    const output: CaptureOutput = {
      slug,
      outDir: caseDir,
      prefixMessageCount: prefix.length,
      failureMessageIndex: opts.failureIndex,
      attachmentsCopied,
      missingAttachments,
    };
    process.stdout.write(stableStringify(output));
  } finally {
    rmSync(extracted.root, { recursive: true, force: true });
  }
}

function lastIndexWhere<T>(
  arr: T[],
  pred: (value: T) => boolean,
): number | null {
  for (let i = arr.length - 1; i >= 0; i--) {
    if (pred(arr[i])) return i;
  }
  return null;
}

function defaultSlug(
  conversationId: string,
  failingTurn: MessageRecord,
): string {
  const shortId = conversationId.slice(0, 8);
  const ts = failingTurn.ts ?? new Date().toISOString();
  const tsSlug = slugify(ts);
  return `${shortId}-${tsSlug}`;
}

function renderNotesMarkdown(
  caseFile: CaseFile,
  developerNotes: string | undefined,
): string {
  const lines: string[] = [];
  lines.push(`# ${caseFile.slug}`);
  lines.push("");
  lines.push(`Captured ${caseFile.createdAt}.`);
  lines.push("");
  lines.push("## Source");
  lines.push("");
  lines.push(`- Conversation: \`${caseFile.source.conversationId}\``);
  if (caseFile.source.exportManifest?.assistantVersion) {
    lines.push(
      `- Assistant version: \`${caseFile.source.exportManifest.assistantVersion}\``,
    );
  }
  if (caseFile.source.exportManifest?.commitSha) {
    lines.push(
      `- Commit SHA: \`${caseFile.source.exportManifest.commitSha}\``,
    );
  }
  lines.push(`- Tar: \`${caseFile.source.tarPath}\``);
  lines.push("");
  lines.push("## Failure");
  lines.push("");
  lines.push(`- Message index: \`${caseFile.failure.messageIndex}\``);
  lines.push(`- Prefix length: ${caseFile.prefix.messageCount} messages`);
  if (caseFile.prefix.missingAttachments.length > 0) {
    lines.push(
      `- Missing attachments: ${caseFile.prefix.missingAttachments
        .map((n) => `\`${n}\``)
        .join(", ")}`,
    );
  }
  lines.push("");
  lines.push("## Expected behavior");
  lines.push("");
  lines.push(caseFile.failure.expectedBehavior);
  lines.push("");
  if (developerNotes && developerNotes.trim().length > 0) {
    lines.push("## Notes");
    lines.push("");
    lines.push(developerNotes.trim());
    lines.push("");
  }
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// CLI wiring
// ---------------------------------------------------------------------------

const USAGE = `Usage:
  capture.ts inspect  --tar <path>
  capture.ts messages --tar <path> [--conversation-id <id>]
  capture.ts capture  --tar <path> [--conversation-id <id>]
                      --failure-index <n>
                      --expected <text>
                      [--notes <text>] [--name <slug>] [--out <dir>]
`;

function requireString(
  values: Record<string, unknown>,
  key: string,
  flag: string,
): string {
  const v = values[key];
  if (typeof v !== "string" || v.length === 0) {
    throw new Error(`missing required flag: ${flag}`);
  }
  return v;
}

function optionalString(
  values: Record<string, unknown>,
  key: string,
): string | undefined {
  const v = values[key];
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

function main(): void {
  const argv = process.argv.slice(2);
  const subcommand = argv[0];
  if (!subcommand || subcommand === "--help" || subcommand === "-h") {
    process.stdout.write(USAGE);
    return;
  }

  const rest = argv.slice(1);

  // Common flag schema covers every subcommand; subcommand handlers pull only
  // what they need. `parseArgs` rejects unknown flags by default, which we
  // want so typos surface as errors instead of silently doing nothing.
  const { values } = parseArgs({
    args: rest,
    options: {
      tar: { type: "string" },
      "conversation-id": { type: "string" },
      "failure-index": { type: "string" },
      expected: { type: "string" },
      notes: { type: "string" },
      name: { type: "string" },
      out: { type: "string" },
    },
    strict: true,
    allowPositionals: false,
  });

  switch (subcommand) {
    case "inspect": {
      runInspect({ tar: requireString(values, "tar", "--tar") });
      return;
    }
    case "messages": {
      runMessages({
        tar: requireString(values, "tar", "--tar"),
        conversationId: optionalString(values, "conversation-id"),
      });
      return;
    }
    case "capture": {
      const failureIndexRaw = requireString(
        values,
        "failure-index",
        "--failure-index",
      );
      const failureIndex = Number.parseInt(failureIndexRaw, 10);
      if (Number.isNaN(failureIndex)) {
        throw new Error(
          `--failure-index must be an integer, got: ${failureIndexRaw}`,
        );
      }
      runCapture({
        tar: requireString(values, "tar", "--tar"),
        conversationId: optionalString(values, "conversation-id"),
        failureIndex,
        expected: requireString(values, "expected", "--expected"),
        notes: optionalString(values, "notes"),
        name: optionalString(values, "name"),
        out: optionalString(values, "out"),
      });
      return;
    }
    default: {
      throw new Error(
        `unknown subcommand: ${subcommand}\n\n${USAGE}`,
      );
    }
  }
}

try {
  main();
} catch (err) {
  const msg = err instanceof Error ? err.message : String(err);
  process.stderr.write(`error: ${msg}\n`);
  process.exit(1);
}
