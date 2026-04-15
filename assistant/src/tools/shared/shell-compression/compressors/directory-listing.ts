import { dirname, extname } from "node:path";

/**
 * Compress directory listing output (ls, find, tree).
 *
 * - `ls -la` style: groups files by extension, collapses groups >10.
 * - `find` style: groups paths by directory, collapses dirs with >5 entries.
 * - Preserves directory entries.
 */
export function compressDirectoryListing(
  stdout: string,
  stderr: string,
  exitCode: number | null,
): string {
  if (exitCode !== 0 && exitCode !== null) {
    return stderr ? `${stderr}\n${stdout}` : stdout;
  }

  const lines = stdout.split("\n").filter((l) => l.trim());
  if (lines.length === 0) return stdout;

  // Detect format: ls -la has permission strings (drwx...) or "total N"
  const isLsLa = lines.some(
    (l) => /^[dlcbps-][rwxsStT-]{9}/.test(l) || /^total\s+\d+/.test(l),
  );

  if (isLsLa) {
    return compressLsOutput(lines);
  }

  // Check for find-style output: lines that look like file paths.
  // Covers ./path, /path, and relative paths like src/file.ts.
  const isFind = lines.every(
    (l) =>
      l.startsWith("./") ||
      l.startsWith("/") ||
      (/\//.test(l) && !/^\s/.test(l)),
  );
  if (isFind) {
    return compressFindOutput(lines);
  }

  // Plain ls (just filenames) — group by extension
  return compressPlainLs(lines);
}

function compressLsOutput(lines: string[]): string {
  const dirLines: string[] = [];
  const byExt = new Map<string, string[]>();

  for (const line of lines) {
    if (/^total\s+\d+/.test(line)) {
      dirLines.push(line);
      continue;
    }

    // Directory entries start with 'd'
    if (line.startsWith("d")) {
      dirLines.push(line);
      continue;
    }

    // Extract filename from ls -la line (last field after the date/time)
    const ext = extractExtFromLsLine(line);
    const group = byExt.get(ext) ?? [];
    group.push(line);
    byExt.set(ext, group);
  }

  const result: string[] = [...dirLines];

  for (const [ext, files] of byExt) {
    if (files.length > 10) {
      const label = ext || "(no extension)";
      result.push(`${files.length} ${label} files`);
    } else {
      result.push(...files);
    }
  }

  result.push(`(${lines.length} entries total)`);
  return result.join("\n");
}

function compressFindOutput(lines: string[]): string {
  const byDir = new Map<string, string[]>();

  for (const line of lines) {
    const dir = dirname(line);
    const group = byDir.get(dir) ?? [];
    group.push(line);
    byDir.set(dir, group);
  }

  const result: string[] = [];

  for (const [dir, files] of byDir) {
    if (files.length > 5) {
      result.push(`${dir}/ (${files.length} files)`);
    } else {
      result.push(...files);
    }
  }

  result.push(`(${lines.length} entries total)`);
  return result.join("\n");
}

function compressPlainLs(lines: string[]): string {
  const byExt = new Map<string, string[]>();

  for (const line of lines) {
    const ext = extname(line) || "(no extension)";
    const group = byExt.get(ext) ?? [];
    group.push(line);
    byExt.set(ext, group);
  }

  const result: string[] = [];

  for (const [ext, files] of byExt) {
    if (files.length > 10) {
      result.push(`${files.length} ${ext} files`);
    } else {
      result.push(...files);
    }
  }

  result.push(`(${lines.length} entries total)`);
  return result.join("\n");
}

function extractExtFromLsLine(line: string): string {
  // ls -la fields: perms links owner group size month day time filename
  const parts = line.split(/\s+/);
  const name = parts[parts.length - 1] ?? "";
  return extname(name) || "(no extension)";
}
