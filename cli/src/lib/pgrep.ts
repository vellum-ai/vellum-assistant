import { execOutput } from "./step-runner";

const PGREP_TIMEOUT_MS = 5_000;

export async function pgrepExact(name: string): Promise<string[]> {
  try {
    const output = await execOutput("pgrep", ["-x", name], {
      timeoutMs: PGREP_TIMEOUT_MS,
    });
    return output.trim().split("\n").filter(Boolean);
  } catch {
    return [];
  }
}
