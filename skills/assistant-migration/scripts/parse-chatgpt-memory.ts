#!/usr/bin/env bun

/**
 * Scan a ChatGPT account export ZIP for non-conversation memory material
 * (saved memories, custom instructions / "what ChatGPT should know about
 * you") and emit `MemoryImportItem[]` JSON on stdout.
 *
 * Conversation history is NOT parsed here: that belongs to the
 * `chatgpt-import` skill. This parser only covers the material described
 * in references/chatgpt.md under "Non-conversation material".
 *
 * ChatGPT does not document a stable filename schema for this material,
 * so no fixed layout is assumed: every entry in the archive is inspected
 * and matched by name/content heuristics. A stderr inventory lists which
 * entries were recognized and which were not, so the creator review step
 * can audit the coverage.
 *
 * Not covered by CI tests: the heuristic surface has no stable upstream
 * fixture to pin (export layouts vary by account and change over time),
 * so output is validated by creator review rather than a fixture test.
 *
 * Usage:
 *   bun run scripts/parse-chatgpt-memory.ts --file /path/to/chatgpt-export.zip
 */

import { existsSync, readFileSync } from "node:fs";
import { inflateRawSync } from "node:zlib";

import {
  printItemsJson,
  toIsoDate,
  type MemoryImportItem,
} from "./lib/memory-items.js";

const SOURCE = "import:chatgpt";

/** JSON keys whose string values look like memories or custom instructions. */
const MEMORY_KEY =
  /memor(y|ies)|instruction|about_user|about_model|know_about|should_know|how.*respond|persona/i;

/** Object fields that carry the text of a memory-shaped record. */
const TEXT_FIELDS = ["content", "memory", "text", "value", "summary", "title"];

/** Object fields that may carry the record's original timestamp. */
const DATE_FIELDS = [
  "created_at",
  "create_time",
  "updated_at",
  "update_time",
  "timestamp",
  "date",
];

const MEDIA_EXTENSIONS =
  /\.(png|jpe?g|gif|webp|svg|mp3|wav|m4a|mp4|webm|pdf|dat|html|css|js)$/i;

const MAX_ENTRY_BYTES = 10 * 1024 * 1024;
const MAX_WALK_DEPTH = 12;

interface InventoryLine {
  entry: string;
  outcome: "recognized" | "skipped";
  detail: string;
}

// -- Heuristic content scanning --

function itemFromRecord(
  record: Record<string, unknown>,
  context: string,
): MemoryImportItem | null {
  for (const field of TEXT_FIELDS) {
    const value = record[field];
    if (typeof value === "string" && value.trim().length > 0) {
      const item: MemoryImportItem = {
        text: value.trim(),
        source: SOURCE,
        context,
      };
      for (const dateField of DATE_FIELDS) {
        const originDate = toIsoDate(record[dateField]);
        if (originDate) {
          item.origin_date = originDate;
          break;
        }
      }
      return item;
    }
  }
  return null;
}

function itemsFromMatchedValue(
  value: unknown,
  context: string,
): MemoryImportItem[] {
  if (typeof value === "string" && value.trim().length > 0) {
    return [{ text: value.trim(), source: SOURCE, context }];
  }
  if (Array.isArray(value)) {
    const items: MemoryImportItem[] = [];
    for (const element of value) {
      if (typeof element === "string" && element.trim().length > 0) {
        items.push({ text: element.trim(), source: SOURCE, context });
      } else if (element && typeof element === "object") {
        const item = itemFromRecord(
          element as Record<string, unknown>,
          context,
        );
        if (item) {
          items.push(item);
        }
      }
    }
    return items;
  }
  return [];
}

/** Recursively collect string values under memory/instruction-looking keys. */
function walkJson(
  value: unknown,
  entryName: string,
  path: string,
  depth: number,
  items: MemoryImportItem[],
): void {
  if (depth > MAX_WALK_DEPTH || value === null || typeof value !== "object") {
    return;
  }
  if (Array.isArray(value)) {
    for (const element of value) {
      walkJson(element, entryName, path, depth + 1, items);
    }
    return;
  }
  for (const [key, child] of Object.entries(value)) {
    const childPath = path ? `${path}.${key}` : key;
    if (MEMORY_KEY.test(key)) {
      const matched = itemsFromMatchedValue(child, `${entryName}:${childPath}`);
      if (matched.length > 0) {
        items.push(...matched);
        continue;
      }
    }
    walkJson(child, entryName, childPath, depth + 1, items);
  }
}

function scanEntry(name: string, data: Buffer): MemoryImportItem[] {
  const text = data.toString("utf-8");

  if (name.toLowerCase().endsWith(".json")) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new Error("invalid JSON");
    }
    const items: MemoryImportItem[] = [];
    // An entry whose own name signals memories may be a bare array of
    // memory records with no memory-named key inside.
    if (MEMORY_KEY.test(name) && Array.isArray(parsed)) {
      items.push(...itemsFromMatchedValue(parsed, name));
    }
    walkJson(parsed, name, "", 0, items);
    return items;
  }

  if (name.toLowerCase().endsWith(".txt") && MEMORY_KEY.test(name)) {
    const trimmed = text.trim();
    if (trimmed.length > 0) {
      return [{ text: trimmed, source: SOURCE, context: name }];
    }
  }

  return [];
}

// -- ZIP entry listing (stdlib-only, same approach as chatgpt-import) --

interface ZipEntry {
  name: string;
  read: () => Buffer;
  compressedSize: number;
}

function listZipEntries(buffer: Buffer): ZipEntry[] {
  // Find end of central directory record (EOCD signature: 0x06054b50)
  let eocdOffset = -1;
  for (let i = buffer.length - 22; i >= 0; i--) {
    if (
      buffer[i] === 0x50 &&
      buffer[i + 1] === 0x4b &&
      buffer[i + 2] === 0x05 &&
      buffer[i + 3] === 0x06
    ) {
      eocdOffset = i;
      break;
    }
  }
  if (eocdOffset === -1) {
    throw new Error(
      "Invalid ZIP file: could not find end of central directory",
    );
  }

  const centralDirOffset = buffer.readUInt32LE(eocdOffset + 16);
  const centralDirEntries = buffer.readUInt16LE(eocdOffset + 10);

  const entries: ZipEntry[] = [];
  let offset = centralDirOffset;
  for (let i = 0; i < centralDirEntries; i++) {
    if (
      buffer[offset] !== 0x50 ||
      buffer[offset + 1] !== 0x4b ||
      buffer[offset + 2] !== 0x01 ||
      buffer[offset + 3] !== 0x02
    ) {
      throw new Error("Invalid ZIP central directory entry");
    }

    const cdCompressedSize = buffer.readUInt32LE(offset + 20);
    const fileNameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const localHeaderOffset = buffer.readUInt32LE(offset + 42);
    const fileName = buffer
      .subarray(offset + 46, offset + 46 + fileNameLength)
      .toString("utf-8");

    if (!fileName.endsWith("/")) {
      entries.push({
        name: fileName,
        compressedSize: cdCompressedSize,
        read: () =>
          extractLocalFile(buffer, localHeaderOffset, cdCompressedSize),
      });
    }

    offset += 46 + fileNameLength + extraLength + commentLength;
  }

  return entries;
}

function extractLocalFile(
  buffer: Buffer,
  offset: number,
  cdCompressedSize: number,
): Buffer {
  if (
    buffer[offset] !== 0x50 ||
    buffer[offset + 1] !== 0x4b ||
    buffer[offset + 2] !== 0x03 ||
    buffer[offset + 3] !== 0x04
  ) {
    throw new Error("Invalid ZIP local file header");
  }

  const compressionMethod = buffer.readUInt16LE(offset + 8);
  const localCompressedSize = buffer.readUInt32LE(offset + 18);
  const compressedSize =
    cdCompressedSize > 0 ? cdCompressedSize : localCompressedSize;
  const fileNameLength = buffer.readUInt16LE(offset + 26);
  const extraLength = buffer.readUInt16LE(offset + 28);

  const dataOffset = offset + 30 + fileNameLength + extraLength;
  const fileData = buffer.subarray(dataOffset, dataOffset + compressedSize);

  if (compressionMethod === 0) {
    return Buffer.from(fileData);
  } else if (compressionMethod === 8) {
    return inflateRawSync(fileData);
  } else {
    throw new Error(`Unsupported ZIP compression method: ${compressionMethod}`);
  }
}

// -- Main --

function parseCliArgs(): { filePath: string } {
  const args = process.argv.slice(2);
  let filePath: string | null = null;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--file" && i + 1 < args.length) {
      filePath = args[i + 1];
      i++;
    }
  }

  if (!filePath) {
    process.stderr.write(
      "Usage: bun run scripts/parse-chatgpt-memory.ts --file <path-to-zip>\n",
    );
    process.exit(1);
  }

  return { filePath };
}

function main() {
  const { filePath } = parseCliArgs();

  if (!filePath.endsWith(".zip")) {
    process.stderr.write(
      "Error: Only ZIP files are accepted. Please provide the ChatGPT export ZIP file.\n",
    );
    process.exit(1);
  }
  if (!existsSync(filePath)) {
    process.stderr.write(`Error: File not found: ${filePath}\n`);
    process.exit(1);
  }

  let entries: ZipEntry[];
  try {
    entries = listZipEntries(readFileSync(filePath));
  } catch (err) {
    process.stderr.write(
      `Error reading export file: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    process.exit(1);
  }

  const items: MemoryImportItem[] = [];
  const inventory: InventoryLine[] = [];

  for (const entry of entries) {
    const baseName = entry.name.split("/").pop() ?? entry.name;

    if (
      /^conversations\.json$/i.test(baseName) ||
      /^chat\.html$/i.test(baseName)
    ) {
      inventory.push({
        entry: entry.name,
        outcome: "skipped",
        detail: "conversation history (handled by the chatgpt-import skill)",
      });
      continue;
    }
    if (MEDIA_EXTENSIONS.test(baseName)) {
      inventory.push({
        entry: entry.name,
        outcome: "skipped",
        detail: "media/asset file",
      });
      continue;
    }
    if (!/\.(json|txt)$/i.test(baseName)) {
      inventory.push({
        entry: entry.name,
        outcome: "skipped",
        detail: "unrecognized format",
      });
      continue;
    }
    if (entry.compressedSize > MAX_ENTRY_BYTES) {
      inventory.push({
        entry: entry.name,
        outcome: "skipped",
        detail: "entry too large to scan",
      });
      continue;
    }

    let found: MemoryImportItem[];
    try {
      found = scanEntry(entry.name, entry.read());
    } catch (err) {
      inventory.push({
        entry: entry.name,
        outcome: "skipped",
        detail: `unreadable (${err instanceof Error ? err.message : String(err)})`,
      });
      continue;
    }

    if (found.length > 0) {
      items.push(...found);
      inventory.push({
        entry: entry.name,
        outcome: "recognized",
        detail: `${found.length} candidate item(s) via name/content heuristics`,
      });
    } else {
      inventory.push({
        entry: entry.name,
        outcome: "skipped",
        detail: "no memory-like or instruction-like content found",
      });
    }
  }

  process.stderr.write("Export entry inventory:\n");
  for (const line of inventory) {
    process.stderr.write(`  ${line.outcome}: ${line.entry} (${line.detail})\n`);
  }
  process.stderr.write(
    `Total: ${items.length} review candidates from ${entries.length} entries. Review before saving to memory.\n`,
  );

  printItemsJson(items);
}

if (import.meta.main) {
  main();
}
