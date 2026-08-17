import path from "node:path";

export function normalizeWindowsPathEntry(
  entry: string,
  environment: NodeJS.ProcessEnv = process.env,
): string {
  const trimmed = entry.trim();
  const unquoted =
    trimmed.startsWith('"') && trimmed.endsWith('"')
      ? trimmed.slice(1, -1)
      : trimmed;
  return unquoted.replace(/%([^%]+)%/g, (match, name: string) => {
    const key = Object.keys(environment).find(
      (candidate) => candidate.toLowerCase() === name.toLowerCase(),
    );
    return key ? (environment[key] ?? match) : match;
  });
}

export function sameWindowsPath(left: string, right: string): boolean {
  return (
    path.win32.resolve(normalizeWindowsPathEntry(left)).toLowerCase() ===
    path.win32.resolve(normalizeWindowsPathEntry(right)).toLowerCase()
  );
}
