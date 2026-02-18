import { readFileSync, unlinkSync, writeFileSync } from "fs";
import { homedir, tmpdir } from "os";
import { join } from "path";

import { hatch } from "./commands/hatch";
import { exec } from "./lib/step-runner";

interface CloudCredentials {
  provider: string;
  projectId?: string;
  serviceAccountKey?: string;
}

interface WorkspaceConfig {
  cloudCredentials?: CloudCredentials;
}

async function activateGcpCredentials(creds: CloudCredentials): Promise<void> {
  if (!creds.serviceAccountKey) {
    throw new Error("No GCP service account key found in config");
  }
  if (!creds.projectId) {
    throw new Error("No GCP project ID found in config");
  }

  const keyPath = join(tmpdir(), `vellum-sa-key-${Date.now()}.json`);
  writeFileSync(keyPath, creds.serviceAccountKey);
  try {
    await exec("gcloud", [
      "auth",
      "activate-service-account",
      `--key-file=${keyPath}`,
    ]);
    await exec("gcloud", ["config", "set", "project", creds.projectId]);
  } finally {
    try {
      unlinkSync(keyPath);
    } catch {}
  }
}

async function main(): Promise<void> {
  const configPath = join(homedir(), ".vellum", "workspace", "config.json");
  let config: WorkspaceConfig;
  try {
    config = JSON.parse(readFileSync(configPath, "utf8")) as WorkspaceConfig;
  } catch {
    throw new Error(
      `Could not read workspace config at ${configPath}. Complete onboarding first.`,
    );
  }

  const creds = config.cloudCredentials;
  if (!creds || creds.provider !== "gcp") {
    throw new Error(
      "No GCP credentials found in workspace config. Select GCP as your cloud provider during onboarding.",
    );
  }

  await activateGcpCredentials(creds);

  process.argv = [process.argv[0], process.argv[1], "hatch", "-d"];
  await hatch();
}

main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  console.error(`Error: ${message}`);
  process.exit(1);
});
