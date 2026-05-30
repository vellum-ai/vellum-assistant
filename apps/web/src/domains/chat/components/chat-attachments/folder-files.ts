
/**
 * Helpers for attaching an entire folder to a chat message.
 *
 * Mirrors how Claude Desktop treats a dropped/selected folder: walk the tree,
 * skip noise (VCS metadata, dependency/build output, OS junk, hidden dirs),
 * cap the total file count, then hand the surviving files to the normal
 * per-file upload pipeline (`useChatAttachments.addFiles`). Folder upload is
 * otherwise just "many attachments on one message", which the composer, upload
 * API, and message protocol already support.
 *
 * Two entry points feed these helpers:
 *  - The `webkitdirectory` file picker, which yields a flat `FileList` where
 *    each file carries a `webkitRelativePath` like `my-folder/src/index.ts`.
 *  - A folder drag-and-drop, which exposes a `FileSystemEntry` tree we walk via
 *    `webkitGetAsEntry()`; we backfill `webkitRelativePath` so both paths share
 *    the same filtering logic.
 */

/**
 * Upper bound on how many files a single folder selection may queue. Folders
 * can hold thousands of files; this keeps a POC from spamming the per-file
 * upload endpoint and overwhelming the composer. Excess files past this limit
 * are dropped (see `filterFolderFiles`).
 */
export const FOLDER_FILE_LIMIT = 200;

/** Directory names skipped anywhere in a folder tree. */
const IGNORED_DIRECTORIES = new Set([
  ".git",
  ".hg",
  ".svn",
  "node_modules",
  "bower_components",
  ".venv",
  "venv",
  "__pycache__",
  "dist",
  "build",
  "out",
  ".next",
  ".nuxt",
  ".turbo",
  ".cache",
  "coverage",
  ".idea",
  ".vscode",
  ".gradle",
  "target",
  "vendor",
]);

/** Exact file names skipped regardless of which directory they live in. */
const IGNORED_FILES = new Set([".DS_Store", "Thumbs.db"]);

/** True for a hidden path segment (dotfile/dotdir), excluding `.`/`..`. */
function isHiddenSegment(segment: string): boolean {
  return segment.startsWith(".") && segment !== "." && segment !== "..";
}

/**
 * True when a POSIX-style relative path (e.g. `src/index.ts`) should be
 * excluded from a folder upload because some segment is ignored noise. Hidden
 * *directories* are skipped, but a hidden *file* at the leaf (e.g. `.env`) is
 * kept — only explicit `IGNORED_FILES` names are dropped.
 */
export function shouldIgnoreFolderPath(relativePath: string): boolean {
  const segments = relativePath.split("/").filter(Boolean);
  if (segments.length === 0) {
    return true;
  }
  const fileName = segments[segments.length - 1] ?? "";
  if (IGNORED_FILES.has(fileName)) {
    return true;
  }
  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index] ?? "";
    const isLast = index === segments.length - 1;
    if (IGNORED_DIRECTORIES.has(segment)) {
      return true;
    }
    if (!isLast && isHiddenSegment(segment)) {
      return true;
    }
  }
  return false;
}

/** Best-effort relative path for a file from either entry point. */
function relativePathFor(file: File): string {
  const withPath = file as File & { webkitRelativePath?: string };
  const rel = withPath.webkitRelativePath;
  return rel && rel.length > 0 ? rel : file.name;
}

export interface FolderFilterResult {
  /** Files that survived filtering, capped at `FOLDER_FILE_LIMIT`. */
  accepted: File[];
  /** Count of files dropped as ignored noise (junk dirs/files). */
  ignored: number;
  /** True when more than `FOLDER_FILE_LIMIT` files survived and were trimmed. */
  truncated: boolean;
}

/**
 * Filters a flat list of folder files down to the ones worth attaching:
 * removes ignored noise and caps the result at `FOLDER_FILE_LIMIT`.
 */
export function filterFolderFiles(files: File[]): FolderFilterResult {
  const kept: File[] = [];
  let ignored = 0;
  for (const file of files) {
    if (shouldIgnoreFolderPath(relativePathFor(file))) {
      ignored += 1;
      continue;
    }
    kept.push(file);
  }
  const truncated = kept.length > FOLDER_FILE_LIMIT;
  return {
    accepted: truncated ? kept.slice(0, FOLDER_FILE_LIMIT) : kept,
    ignored,
    truncated,
  };
}

/** Read a single `FileSystemFileEntry` into a `File`, or null on error. */
function readFileEntry(entry: FileSystemFileEntry): Promise<File | null> {
  return new Promise((resolve) => {
    entry.file(
      (file) => resolve(file),
      () => resolve(null),
    );
  });
}

/** Drain a directory reader fully (it returns entries in batches of ~100). */
function readDirectoryEntries(
  reader: FileSystemDirectoryReader,
): Promise<FileSystemEntry[]> {
  return new Promise((resolve) => {
    reader.readEntries(
      (entries) => resolve(entries),
      () => resolve([]),
    );
  });
}

/** Recursively collect files from a `FileSystemEntry` into `out`. */
async function walkEntry(entry: FileSystemEntry, out: File[]): Promise<void> {
  if (entry.isFile) {
    const file = await readFileEntry(entry as FileSystemFileEntry);
    if (file) {
      // `entry.fullPath` looks like `/my-folder/src/index.ts`; strip the
      // leading slash so it matches the picker's `webkitRelativePath` shape,
      // then shadow the (read-only) prototype getter so filtering/display can
      // read folder structure uniformly across both entry points.
      const relativePath = entry.fullPath.replace(/^\/+/, "");
      try {
        Object.defineProperty(file, "webkitRelativePath", {
          value: relativePath,
          configurable: true,
        });
      } catch {
        // Some engines disallow shadowing the getter; filtering then falls
        // back to `file.name`, which is still correct for top-level files.
      }
      out.push(file);
    }
    return;
  }
  if (entry.isDirectory) {
    // Prune ignored/hidden directories before descending so we never read into
    // node_modules, .git, etc.
    if (IGNORED_DIRECTORIES.has(entry.name) || isHiddenSegment(entry.name)) {
      return;
    }
    const reader = (entry as FileSystemDirectoryEntry).createReader();
    let batch = await readDirectoryEntries(reader);
    while (batch.length > 0) {
      for (const child of batch) {
        await walkEntry(child, out);
      }
      batch = await readDirectoryEntries(reader);
    }
  }
}

/**
 * True when a drag contains at least one directory entry, meaning the caller
 * must use the async `collectDataTransferFolderFiles` walk instead of the flat
 * `DataTransfer.files` list. Must be called synchronously inside the drop
 * handler while the `DataTransfer` is still live.
 */
export function dataTransferHasDirectory(dataTransfer: DataTransfer): boolean {
  const items = dataTransfer.items;
  if (!items) {
    return false;
  }
  for (let index = 0; index < items.length; index += 1) {
    const item = items[index];
    if (
      item &&
      item.kind === "file" &&
      typeof item.webkitGetAsEntry === "function"
    ) {
      const entry = item.webkitGetAsEntry();
      if (entry?.isDirectory) {
        return true;
      }
    }
  }
  return false;
}

/**
 * Collects every file from a drag that includes one or more folders, walking
 * directory entries recursively. Returns a flat `File[]` with
 * `webkitRelativePath` backfilled so folder structure survives to filtering.
 *
 * The `DataTransferItemList` is invalidated once the drop handler returns, so
 * we snapshot all entries synchronously (before the first `await`) — callers
 * must invoke this synchronously from within the drop handler.
 */
export async function collectDataTransferFolderFiles(
  dataTransfer: DataTransfer,
): Promise<File[]> {
  const items = dataTransfer.items;
  const out: File[] = [];
  if (!items) {
    return out;
  }
  const entries: FileSystemEntry[] = [];
  for (let index = 0; index < items.length; index += 1) {
    const item = items[index];
    if (
      item &&
      item.kind === "file" &&
      typeof item.webkitGetAsEntry === "function"
    ) {
      const entry = item.webkitGetAsEntry();
      if (entry) {
        entries.push(entry);
      }
    }
  }
  for (const entry of entries) {
    await walkEntry(entry, out);
  }
  return out;
}
