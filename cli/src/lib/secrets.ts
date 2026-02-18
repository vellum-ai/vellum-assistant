import { execOutput } from "./step-runner";

export async function fetchGcpSecret(name: string, project: string): Promise<string | null> {
  try {
    return await execOutput("gcloud", [
      "secrets",
      "versions",
      "access",
      "latest",
      `--secret=${name}`,
      `--project=${project}`,
    ]);
  } catch {
    return null;
  }
}

export async function ensureAnthropicKey(project: string): Promise<void> {
  if (process.env.ANTHROPIC_API_KEY) {
    return;
  }

  const value = await fetchGcpSecret("ANTHROPIC_API_KEY", project);
  if (value) {
    process.env.ANTHROPIC_API_KEY = value;
  }
}
