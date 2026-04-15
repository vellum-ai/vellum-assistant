/**
 * Compress grep/ripgrep search output by grouping matches by file.
 *
 * - Groups matches by file path.
 * - Files with >5 matches: keep first 2 + last 1 with count.
 * - Preserves all unique file paths.
 */
export function compressSearchResults(
  stdout: string,
  stderr: string,
  exitCode: number | null,
): string {
  if (exitCode !== 0 && exitCode !== null) {
    return stderr ? `${stderr}\n${stdout}` : stdout;
  }

  const lines = stdout.split("\n").filter((l) => l.trim());
  if (lines.length === 0) return stdout;

  // Detect grep/rg format: file:line:content or file:content
  const matchPattern = /^([^:]+):(\d+:)?(.*)$/;
  const byFile = new Map<string, string[]>();
  const nonMatchLines: string[] = [];

  for (const line of lines) {
    const m = line.match(matchPattern);
    if (m) {
      const filePath = m[1]!;
      const group = byFile.get(filePath) ?? [];
      group.push(line);
      byFile.set(filePath, group);
    } else {
      nonMatchLines.push(line);
    }
  }

  // If nothing looked like grep output, return as-is
  if (byFile.size === 0) return stdout;

  const result: string[] = [...nonMatchLines];

  for (const [filePath, matches] of byFile) {
    if (matches.length > 5) {
      result.push(matches[0]!);
      result.push(matches[1]!);
      result.push(`  ... (${matches.length - 3} more matches in ${filePath})`);
      result.push(matches[matches.length - 1]!);
    } else {
      result.push(...matches);
    }
  }

  result.push(
    `(${byFile.size} files, ${lines.length - nonMatchLines.length} matches total)`,
  );
  return result.join("\n");
}
