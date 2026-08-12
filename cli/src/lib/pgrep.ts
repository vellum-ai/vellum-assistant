import { execOutput } from "./step-runner";
import { executableName, parseTasklistCsv } from "./process.js";

const PGREP_TIMEOUT_MS = 5_000;

export async function pgrepExact(
  name: string,
  hostPlatform: NodeJS.Platform = process.platform,
): Promise<string[]> {
  try {
    const command = hostPlatform === "win32" ? "tasklist.exe" : "pgrep";
    const args =
      hostPlatform === "win32"
        ? [
            "/FI",
            `IMAGENAME eq ${executableName(name, hostPlatform)}`,
            "/FO",
            "CSV",
            "/NH",
          ]
        : ["-x", name];
    const output = await execOutput(command, args, {
      timeoutMs: PGREP_TIMEOUT_MS,
    });
    if (hostPlatform === "win32") {
      return parseTasklistCsv(output).map(({ pid }) => String(pid));
    }
    return output.trim().split("\n").filter(Boolean);
  } catch {
    return [];
  }
}
