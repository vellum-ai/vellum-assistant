#!/usr/bin/env bun

/**
 * Census a corpus directory and propose a slice plan for skim passes.
 *
 * Walks the directory recursively (skipping dot-files and dot-directories,
 * so a `.staging/` tree inside the corpus is not counted), records size and
 * date per file, and groups files into date-windowed slices sized for one
 * summarization pass each.
 *
 * Per-file dates prefer a date embedded in the filename (2025-03-12,
 * 2025_03_12, or 20250312) and fall back to the file mtime. Slices group by
 * month, coarsening to quarter and then year when the month count exceeds
 * the slice budget; buckets with too many files are split into parts.
 *
 * Usage:
 *   bun run scripts/inventory.ts <corpus-dir>
 *
 * Stdout: JSON { files, totalBytes, byExtension, dateRange, suggestedSlices }
 * Stderr: human-readable census.
 */

import { readdirSync, statSync } from "node:fs";
import { extname, join } from "node:path";

// -- Types --

export interface FileInfo {
  /** Path relative to the corpus root, with forward slashes. */
  path: string;
  bytes: number;
  /** ISO date (YYYY-MM-DD): filename date when present, else mtime date. */
  date: string;
  /** True when `date` came from the filename rather than the mtime. */
  dateFromName: boolean;
}

export interface Slice {
  label: string;
  earliest: string;
  latest: string;
  fileCount: number;
  bytes: number;
  paths: string[];
}

export interface Inventory {
  files: number;
  totalBytes: number;
  byExtension: Record<string, number>;
  dateRange: { earliest: string; latest: string } | null;
  suggestedSlices: Slice[];
}

export interface SliceOptions {
  /** Upper bound on slice count before coarsening the date grain. */
  maxSlices?: number;
  /** Buckets with more files than this are split into parts. */
  maxFilesPerSlice?: number;
}

const DEFAULT_MAX_SLICES = 40;
const DEFAULT_MAX_FILES_PER_SLICE = 200;

// -- Filename date extraction --

const FILENAME_DATE_PATTERNS = [
  /(\d{4})-(\d{2})-(\d{2})/, // 2025-03-12
  /(\d{4})_(\d{2})_(\d{2})/, // 2025_03_12
  /(?<![0-9])(\d{4})(\d{2})(\d{2})(?![0-9])/, // 20250312
];

/**
 * Extract an ISO date (YYYY-MM-DD) from a date-like pattern in a file path,
 * or null when no plausible date is present. Candidates are validated
 * against the actual calendar (a UTC round-trip), so version strings like
 * 1.2.20250199 and impossible dates like 2025-02-29 in a non-leap year or
 * 2025-04-31 do not match; callers then fall back to the file mtime.
 */
export function dateFromFilename(path: string): string | null {
  for (const pattern of FILENAME_DATE_PATTERNS) {
    const match = path.match(pattern);
    if (!match) {
      continue;
    }
    const year = Number(match[1]);
    const month = Number(match[2]);
    const day = Number(match[3]);
    if (year < 1980 || year > 2100) {
      continue;
    }
    // Round-trip through Date.UTC: JavaScript normalizes overflow (month 13
    // becomes January, April 31 becomes May 1), so a candidate is a real
    // calendar date only when every component survives unchanged.
    const roundTrip = new Date(Date.UTC(year, month - 1, day));
    if (
      roundTrip.getUTCFullYear() !== year ||
      roundTrip.getUTCMonth() !== month - 1 ||
      roundTrip.getUTCDate() !== day
    ) {
      continue;
    }
    return `${match[1]}-${match[2]}-${match[3]}`;
  }
  return null;
}

// -- Directory walk --

/**
 * Recursively list files under `root`. Dot-files and dot-directories are
 * skipped so staging trees (`.staging/`) and OS litter are not censused.
 */
export function walkFiles(root: string): FileInfo[] {
  const results: FileInfo[] = [];
  const walk = (dir: string, rel: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name.startsWith(".")) {
        continue;
      }
      const full = join(dir, entry.name);
      const relPath = rel === "" ? entry.name : `${rel}/${entry.name}`;
      if (entry.isDirectory()) {
        walk(full, relPath);
      } else if (entry.isFile()) {
        const stat = statSync(full);
        const nameDate = dateFromFilename(relPath);
        results.push({
          path: relPath,
          bytes: stat.size,
          date: nameDate ?? isoDate(stat.mtimeMs),
          dateFromName: nameDate !== null,
        });
      }
    }
  };
  walk(root, "");
  results.sort((a, b) =>
    a.date === b.date
      ? a.path.localeCompare(b.path)
      : a.date.localeCompare(b.date),
  );
  return results;
}

function isoDate(epochMs: number): string {
  return new Date(epochMs).toISOString().slice(0, 10);
}

// -- Slice planning --

function quarterKey(date: string): string {
  const month = Number(date.slice(5, 7));
  const quarter = Math.ceil(month / 3);
  return `${date.slice(0, 4)}-Q${quarter}`;
}

function groupBy(
  files: FileInfo[],
  keyOf: (date: string) => string,
): Map<string, FileInfo[]> {
  const groups = new Map<string, FileInfo[]>();
  for (const file of files) {
    const key = keyOf(file.date);
    const bucket = groups.get(key);
    if (bucket) {
      bucket.push(file);
    } else {
      groups.set(key, [file]);
    }
  }
  return groups;
}

function toSlice(label: string, bucket: FileInfo[]): Slice {
  return {
    label,
    earliest: bucket[0].date,
    latest: bucket[bucket.length - 1].date,
    fileCount: bucket.length,
    bytes: bucket.reduce((sum, f) => sum + f.bytes, 0),
    paths: bucket.map((f) => f.path),
  };
}

/** Split any bucket larger than `maxFilesPerSlice` into sequential parts. */
function splitOversize(
  label: string,
  bucket: FileInfo[],
  maxFilesPerSlice: number,
): Slice[] {
  if (bucket.length <= maxFilesPerSlice) {
    return [toSlice(label, bucket)];
  }
  const parts = Math.ceil(bucket.length / maxFilesPerSlice);
  const perPart = Math.ceil(bucket.length / parts);
  const slices: Slice[] = [];
  for (let i = 0; i < parts; i++) {
    const chunk = bucket.slice(i * perPart, (i + 1) * perPart);
    if (chunk.length > 0) {
      slices.push(toSlice(`${label} (part ${i + 1})`, chunk));
    }
  }
  return slices;
}

/**
 * Group files (already sorted by date) into date-windowed slices: monthly,
 * coarsening to quarterly and then yearly when the group count exceeds
 * `maxSlices`, with oversize buckets split into parts.
 */
export function suggestSlices(
  files: FileInfo[],
  options: SliceOptions = {},
): Slice[] {
  const maxSlices = options.maxSlices ?? DEFAULT_MAX_SLICES;
  const maxFilesPerSlice =
    options.maxFilesPerSlice ?? DEFAULT_MAX_FILES_PER_SLICE;
  if (files.length === 0) {
    return [];
  }

  const grains: Array<(date: string) => string> = [
    (date) => date.slice(0, 7), // month: 2025-03
    quarterKey, // quarter: 2025-Q1
    (date) => date.slice(0, 4), // year: 2025
  ];

  // Try month, then quarter, then year; if even years exceed the budget
  // (a decades-spanning corpus), the yearly grouping is used as-is.
  let groups = groupBy(files, grains[0]);
  for (let i = 1; i < grains.length && groups.size > maxSlices; i++) {
    groups = groupBy(files, grains[i]);
  }

  const slices: Slice[] = [];
  for (const label of [...groups.keys()].sort()) {
    slices.push(...splitOversize(label, groups.get(label)!, maxFilesPerSlice));
  }
  return slices;
}

// -- Inventory assembly --

export function buildInventory(
  root: string,
  options: SliceOptions = {},
): Inventory {
  const files = walkFiles(root);
  const byExtension: Record<string, number> = {};
  let totalBytes = 0;
  for (const file of files) {
    const ext = extname(file.path).toLowerCase() || "(none)";
    byExtension[ext] = (byExtension[ext] ?? 0) + 1;
    totalBytes += file.bytes;
  }
  return {
    files: files.length,
    totalBytes,
    byExtension,
    dateRange:
      files.length === 0
        ? null
        : { earliest: files[0].date, latest: files[files.length - 1].date },
    suggestedSlices: suggestSlices(files, options),
  };
}

// -- CLI --

function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024 * 1024) {
    return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
  }
  if (bytes >= 1024 * 1024) {
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }
  if (bytes >= 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`;
  }
  return `${bytes} B`;
}

function main(): void {
  const dir = process.argv[2];
  if (!dir) {
    console.error("Usage: bun run scripts/inventory.ts <corpus-dir>");
    process.exit(1);
  }
  if (!statSync(dir, { throwIfNoEntry: false })?.isDirectory()) {
    console.error(`Not a directory: ${dir}`);
    process.exit(1);
  }

  const inventory = buildInventory(dir);

  console.error(`Corpus census for ${dir}`);
  console.error(`  files: ${inventory.files}`);
  console.error(`  total size: ${formatBytes(inventory.totalBytes)}`);
  const extensions = Object.entries(inventory.byExtension)
    .sort((a, b) => b[1] - a[1])
    .map(([ext, count]) => `${ext} x${count}`)
    .join(", ");
  console.error(`  extensions: ${extensions || "(none)"}`);
  if (inventory.dateRange) {
    console.error(
      `  date range: ${inventory.dateRange.earliest} to ${inventory.dateRange.latest}`,
    );
  }
  console.error(`  suggested slices: ${inventory.suggestedSlices.length}`);
  for (const slice of inventory.suggestedSlices) {
    console.error(
      `    ${slice.label}: ${slice.fileCount} files, ${formatBytes(slice.bytes)} (${slice.earliest} to ${slice.latest})`,
    );
  }

  console.log(JSON.stringify(inventory, null, 2));
}

if (import.meta.main) {
  main();
}
