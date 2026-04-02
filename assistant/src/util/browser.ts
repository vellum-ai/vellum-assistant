import { isLinux, isMacOS } from "./platform.js";

/**
 * Open a URL in the user's default browser, falling back to printing the URL
 * to stderr on unsupported platforms.
 */
export function openInBrowser(url: string): void {
  if (isMacOS()) {
    Bun.spawn(["open", url], { stdout: "ignore", stderr: "ignore" });
  } else if (isLinux()) {
    Bun.spawn(["xdg-open", url], { stdout: "ignore", stderr: "ignore" });
  } else {
    process.stderr.write(`Open this URL to authorize:\n\n${url}\n`);
  }
}
