export function desktopChromeCommand(
  executable: string,
  profileDir: string,
): string[] {
  return [
    executable,
    "--no-sandbox",
    "--no-first-run",
    "--disable-dev-shm-usage",
    // Both flags are required to restore a crashed session without prompting.
    "--restore-last-session",
    "--hide-crash-restore-bubble",
    `--user-data-dir=${profileDir}`,
  ];
}
