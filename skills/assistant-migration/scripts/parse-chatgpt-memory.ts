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
 * The ZIP is read incrementally, never materialized whole: the end of
 * central directory record is located from a bounded tail read, only the
 * central directory itself is buffered (kilobytes per thousand entries),
 * and entry bytes are read and inflated only for entries that pass the
 * name and size filters. Media files and oversized entries are skipped
 * without their bytes ever being read, so multi-GB exports parse in
 * bounded memory.
 *
 * Not covered by CI tests: the heuristic surface has no stable upstream
 * fixture to pin (export layouts vary by account and change over time),
 * so output is validated by creator review rather than a fixture test.
 *
 * Usage:
 *   bun run scripts/parse-chatgpt-memory.ts --file /path/to/chatgpt-export.zip
 */

import { closeSync, existsSync, fstatSync, openSync, readSync } from "node:fs";
import { inflateRawSync } from "node:zlib";

import {
  printItemsJson,
  toIsoDate,
  type MemoryImportItem,
} from "./lib/memory-items.js";
// The DB parser guards its CLI entry behind import.meta.main, so importing
// its redaction helper does not execute it.
import { redactSecretValues } from "./parse-agent-memory-db.js";

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
  depth = 0,
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
  if (value && typeof value === "object") {
    // An object-shaped memory, e.g. {"memory": {"content": "..."}}: pull
    // its text-bearing field (with origin_date when a date field is
    // present). When no text field matches directly, the record may nest
    // one level deeper, so recurse a single level into its values.
    const record = value as Record<string, unknown>;
    const item = itemFromRecord(record, context);
    if (item) {
      return [item];
    }
    if (depth < 1) {
      const items: MemoryImportItem[] = [];
      for (const [key, child] of Object.entries(record)) {
        if (DATE_FIELDS.includes(key)) {
          continue;
        }
        items.push(...itemsFromMatchedValue(child, context, depth + 1));
      }
      return items;
    }
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

// -- Incremental ZIP entry listing (stdlib-only) --
//
// The archive is never read whole. Only three regions are ever buffered:
// a bounded tail (to find the end of central directory record), the
// central directory itself, and the bytes of individual entries that the
// caller decides to read. Entries the caller skips (media, oversized)
// cost zero data reads.

interface ZipEntry {
  name: string;
  read: () => Buffer;
  compressedSize: number;
  uncompressedSize: number;
}

const EOCD_MIN_SIZE = 22;
const MAX_ZIP_COMMENT = 0xffff;

/** Read exactly `length` bytes at `position`, or throw. */
function readAt(fd: number, position: number, length: number): Buffer {
  const buffer = Buffer.alloc(length);
  let read = 0;
  while (read < length) {
    const n = readSync(fd, buffer, read, length - read, position + read);
    if (n <= 0) {
      throw new Error("Invalid ZIP file: unexpected end of file");
    }
    read += n;
  }
  return buffer;
}

function readUInt64LE(buffer: Buffer, offset: number): number {
  const value = buffer.readBigUInt64LE(offset);
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error("Invalid ZIP file: 64-bit field exceeds safe integer");
  }
  return Number(value);
}

/**
 * ZIP64 extended information extra field (header id 0x0001): 64-bit
 * values are stored in extra-field order (uncompressed size, compressed
 * size, local header offset), but only for the fields whose 32-bit slot
 * is saturated at 0xffffffff.
 */
function applyZip64Extra(
  extra: Buffer,
  sizes: {
    uncompressedSize: number;
    compressedSize: number;
    localHeaderOffset: number;
  },
): void {
  let offset = 0;
  while (offset + 4 <= extra.length) {
    const headerId = extra.readUInt16LE(offset);
    const dataSize = extra.readUInt16LE(offset + 2);
    if (headerId === 0x0001) {
      let fieldOffset = offset + 4;
      const fieldEnd = Math.min(offset + 4 + dataSize, extra.length);
      const take = (): number => {
        if (fieldOffset + 8 > fieldEnd) {
          throw new Error("Invalid ZIP file: truncated ZIP64 extra field");
        }
        const value = readUInt64LE(extra, fieldOffset);
        fieldOffset += 8;
        return value;
      };
      if (sizes.uncompressedSize === 0xffffffff) {
        sizes.uncompressedSize = take();
      }
      if (sizes.compressedSize === 0xffffffff) {
        sizes.compressedSize = take();
      }
      if (sizes.localHeaderOffset === 0xffffffff) {
        sizes.localHeaderOffset = take();
      }
      return;
    }
    offset += 4 + dataSize;
  }
}

function listZipEntries(fd: number, fileSize: number): ZipEntry[] {
  // Find the end of central directory record (EOCD signature
  // 0x06054b50) by scanning a bounded tail read: the EOCD is at most
  // 22 bytes plus a 64 KiB comment from the end of the file.
  const tailLength = Math.min(fileSize, EOCD_MIN_SIZE + MAX_ZIP_COMMENT);
  if (tailLength < EOCD_MIN_SIZE) {
    throw new Error("Invalid ZIP file: too small to contain a ZIP archive");
  }
  const tailStart = fileSize - tailLength;
  const tail = readAt(fd, tailStart, tailLength);

  let eocdOffset = -1;
  for (let i = tail.length - EOCD_MIN_SIZE; i >= 0; i--) {
    if (
      tail[i] === 0x50 &&
      tail[i + 1] === 0x4b &&
      tail[i + 2] === 0x05 &&
      tail[i + 3] === 0x06
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

  let centralDirEntries: number = tail.readUInt16LE(eocdOffset + 10);
  let centralDirSize: number = tail.readUInt32LE(eocdOffset + 12);
  let centralDirOffset: number = tail.readUInt32LE(eocdOffset + 16);

  // ZIP64: exports larger than 4 GiB saturate the 32-bit EOCD fields and
  // store the real values in a ZIP64 EOCD record, located via a fixed
  // 20-byte locator that immediately precedes the classic EOCD.
  if (
    centralDirEntries === 0xffff ||
    centralDirSize === 0xffffffff ||
    centralDirOffset === 0xffffffff
  ) {
    const locatorStart = tailStart + eocdOffset - 20;
    if (locatorStart < 0) {
      throw new Error("Invalid ZIP file: missing ZIP64 EOCD locator");
    }
    const locator = readAt(fd, locatorStart, 20);
    if (locator.readUInt32LE(0) !== 0x07064b50) {
      throw new Error("Invalid ZIP file: missing ZIP64 EOCD locator");
    }
    const zip64EocdOffset = readUInt64LE(locator, 8);
    const zip64Eocd = readAt(fd, zip64EocdOffset, 56);
    if (zip64Eocd.readUInt32LE(0) !== 0x06064b50) {
      throw new Error("Invalid ZIP file: missing ZIP64 EOCD record");
    }
    centralDirEntries = readUInt64LE(zip64Eocd, 32);
    centralDirSize = readUInt64LE(zip64Eocd, 40);
    centralDirOffset = readUInt64LE(zip64Eocd, 48);
  }

  // The central directory is tiny relative to the archive (roughly
  // 50-100 bytes per entry), so buffering it whole is safe.
  const centralDir = readAt(fd, centralDirOffset, centralDirSize);

  const entries: ZipEntry[] = [];
  let offset = 0;
  for (let i = 0; i < centralDirEntries; i++) {
    if (
      centralDir[offset] !== 0x50 ||
      centralDir[offset + 1] !== 0x4b ||
      centralDir[offset + 2] !== 0x01 ||
      centralDir[offset + 3] !== 0x02
    ) {
      throw new Error("Invalid ZIP central directory entry");
    }

    const sizes = {
      compressedSize: centralDir.readUInt32LE(offset + 20),
      uncompressedSize: centralDir.readUInt32LE(offset + 24),
      localHeaderOffset: centralDir.readUInt32LE(offset + 42),
    };
    const fileNameLength = centralDir.readUInt16LE(offset + 28);
    const extraLength = centralDir.readUInt16LE(offset + 30);
    const commentLength = centralDir.readUInt16LE(offset + 32);
    const fileName = centralDir
      .subarray(offset + 46, offset + 46 + fileNameLength)
      .toString("utf-8");

    if (
      sizes.compressedSize === 0xffffffff ||
      sizes.uncompressedSize === 0xffffffff ||
      sizes.localHeaderOffset === 0xffffffff
    ) {
      const extraStart = offset + 46 + fileNameLength;
      applyZip64Extra(
        centralDir.subarray(extraStart, extraStart + extraLength),
        sizes,
      );
    }

    if (!fileName.endsWith("/")) {
      entries.push({
        name: fileName,
        compressedSize: sizes.compressedSize,
        uncompressedSize: sizes.uncompressedSize,
        read: () =>
          extractLocalFile(fd, sizes.localHeaderOffset, sizes.compressedSize),
      });
    }

    offset += 46 + fileNameLength + extraLength + commentLength;
  }

  return entries;
}

function extractLocalFile(
  fd: number,
  localHeaderOffset: number,
  cdCompressedSize: number,
): Buffer {
  const header = readAt(fd, localHeaderOffset, 30);
  if (
    header[0] !== 0x50 ||
    header[1] !== 0x4b ||
    header[2] !== 0x03 ||
    header[3] !== 0x04
  ) {
    throw new Error("Invalid ZIP local file header");
  }

  const compressionMethod = header.readUInt16LE(8);
  const localCompressedSize = header.readUInt32LE(18);
  const compressedSize =
    cdCompressedSize > 0 ? cdCompressedSize : localCompressedSize;
  const fileNameLength = header.readUInt16LE(26);
  const extraLength = header.readUInt16LE(28);

  const dataOffset = localHeaderOffset + 30 + fileNameLength + extraLength;
  const fileData = readAt(fd, dataOffset, compressedSize);

  if (compressionMethod === 0) {
    return fileData;
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

  let fd = -1;
  let entries: ZipEntry[];
  try {
    fd = openSync(filePath, "r");
    entries = listZipEntries(fd, fstatSync(fd).size);
  } catch (err) {
    if (fd !== -1) {
      closeSync(fd);
    }
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
    if (
      entry.compressedSize > MAX_ENTRY_BYTES ||
      entry.uncompressedSize > MAX_ENTRY_BYTES
    ) {
      inventory.push({
        entry: entry.name,
        outcome: "skipped",
        detail: "entry too large to scan",
      });
      continue;
    }

    let found: MemoryImportItem[];
    try {
      // Only entries that survived the filters above are ever read; the
      // read is an on-demand seek into the archive, not a slice of a
      // whole-file buffer.
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

  closeSync(fd);

  process.stderr.write("Export entry inventory:\n");
  for (const line of inventory) {
    process.stderr.write(`  ${line.outcome}: ${line.entry} (${line.detail})\n`);
  }
  // Same value-level guarantee as the DB parser: credential-shaped spans in
  // saved memories or custom instructions never reach stdout verbatim.
  let redactionCount = 0;
  const redactedItems = items.map((item) => {
    const { text, redactions } = redactSecretValues(item.text);
    redactionCount += redactions;
    return redactions > 0 ? { ...item, text } : item;
  });
  if (redactionCount > 0) {
    process.stderr.write(
      `Redacted ${redactionCount} secret-like value(s) in place.\n`,
    );
  }
  process.stderr.write(
    `Total: ${redactedItems.length} review candidates from ${entries.length} entries. Review before saving to memory.\n`,
  );

  printItemsJson(redactedItems);
}

if (import.meta.main) {
  main();
}
