import { dirname } from "node:path";

/**
 * Compress `git status` output by grouping untracked files by directory.
 *
 * - Modified/staged/deleted files are always kept individually.
 * - Untracked files (`??`) are grouped by parent directory; groups >5 are collapsed.
 * - Branch tracking info (`## ...`) is preserved.
 */
export function compressGitStatus(
  stdout: string,
  stderr: string,
  exitCode: number | null,
): string {
  if (exitCode !== 0 && exitCode !== null) {
    return stderr ? `${stderr}\n${stdout}` : stdout;
  }

  const lines = stdout.split("\n");
  const branchLines: string[] = [];
  const importantLines: string[] = [];
  const untrackedByDir = new Map<string, string[]>();

  for (const line of lines) {
    if (!line.trim()) continue;

    if (line.startsWith("##")) {
      branchLines.push(line);
      continue;
    }

    if (line.startsWith("?? ") || line.startsWith("?  ")) {
      const filePath = line.slice(3).trim();
      // Directory entries (trailing /) are kept individually — dirname()
      // would return "." and merge them all into one misleading group.
      if (filePath.endsWith("/")) {
        importantLines.push(line);
        continue;
      }
      const dir = dirname(filePath);
      const group = untrackedByDir.get(dir) ?? [];
      group.push(line);
      untrackedByDir.set(dir, group);
      continue;
    }

    // Modified, added, deleted, renamed, copied, unmerged — always keep
    importantLines.push(line);
  }

  const result: string[] = [...branchLines, ...importantLines];

  for (const [dir, files] of untrackedByDir) {
    if (files.length > 5) {
      result.push(`?? ${dir}/ (${files.length} files)`);
    } else {
      result.push(...files);
    }
  }

  return result.join("\n");
}
