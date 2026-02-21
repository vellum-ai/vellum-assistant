import { execOutput } from "./step-runner";

const GS_PROJECT_ID = "vellum-nonprod";

export async function fetchGcpSecret(name: string): Promise<string | null> {
  try {
    return await execOutput("gcloud", [
      "secrets",
      "versions",
      "access",
      "latest",
      `--secret=${name}`,
      `--project=${GS_PROJECT_ID}`,
    ]);
  } catch {
    return null;
  }
}

export async function ensureAnthropicKey(): Promise<void> {
  if (process.env.ANTHROPIC_API_KEY) {
    return;
  }

  const value = await fetchGcpSecret("ANTHROPIC_API_KEY");
  if (value) {
    process.env.ANTHROPIC_API_KEY = value;
  }
}
