import { spawn } from "node:child_process";

/**
 * Open a URL in the user's default browser. Best-effort: a failure to launch is
 * swallowed so the caller can still surface the URL for the user to copy.
 */
export function openBrowser(url: string): void {
  const platform = process.platform;
  const cmd =
    platform === "darwin" ? "open" : platform === "win32" ? "cmd" : "xdg-open";
  const args =
    platform === "win32"
      ? ["/c", "start", '""', url.replace(/&/g, "^&")]
      : [url];
  const child = spawn(cmd, args, { stdio: "ignore", detached: true });
  child.on("error", () => {
    // Silently ignore — the user can still copy the URL from the console.
  });
  child.unref();
}
