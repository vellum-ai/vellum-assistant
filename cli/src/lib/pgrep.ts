import { execOutput } from "./step-runner";

export async function pgrepExact(name: string): Promise<string[]> {
  try {
    const output = await execOutput("pgrep", ["-x", name]);
    return output.trim().split("\n").filter(Boolean);
  } catch {
    return [];
  }
}
