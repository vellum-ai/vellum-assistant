import { exec, execOutput } from "./step-runner";

async function instanceExists(
  instanceName: string,
  project: string,
  zone: string,
): Promise<boolean> {
  try {
    await execOutput("gcloud", [
      "compute",
      "instances",
      "describe",
      instanceName,
      `--project=${project}`,
      `--zone=${zone}`,
      "--format=get(name)",
    ]);
    return true;
  } catch (error) {
    const msg = error instanceof Error ? error.message.toLowerCase() : "";
    if (
      msg.includes("was not found") ||
      msg.includes("could not fetch resource")
    ) {
      return false;
    }
    throw error;
  }
}

async function checkGcloudAvailable(): Promise<boolean> {
  try {
    await execOutput("gcloud", ["--version"]);
    return true;
  } catch {
    return false;
  }
}

export async function retireInstance(
  name: string,
  project: string,
  zone: string,
  source?: string,
): Promise<void> {
  const gcloudOk = await checkGcloudAvailable();
  if (!gcloudOk) {
    throw new Error(
      `Cannot retire GCP instance '${name}': gcloud CLI is not installed or not in PATH. ` +
        `Please install the Google Cloud SDK and try again, or delete the instance manually ` +
        `via the GCP Console (project=${project}, zone=${zone}).`,
    );
  }

  let exists: boolean;
  try {
    exists = await instanceExists(name, project, zone);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Cannot verify GCP instance '${name}': gcloud authentication failed.\n` +
        `Ensure you are authenticated with 'gcloud auth login' or provide valid credentials.\n\n` +
        `Details: ${detail}`,
    );
  }
  if (!exists) {
    console.warn(
      `\u26a0\ufe0f  Instance ${name} not found in GCP (project=${project}, zone=${zone}).`,
    );
    return;
  }

  if (source) {
    try {
      await exec("gcloud", [
        "compute",
        "instances",
        "add-labels",
        name,
        `--project=${project}`,
        `--zone=${zone}`,
        `--labels=retired-by=${source}`,
      ]);
    } catch {
      console.warn(`\u26a0\ufe0f  Could not label instance before deletion`);
    }
  }

  console.log(`\u{1F5D1}\ufe0f  Deleting GCP instance ${name}\n`);

  await exec("gcloud", [
    "compute",
    "instances",
    "delete",
    name,
    `--project=${project}`,
    `--zone=${zone}`,
    "--quiet",
  ]);

  console.log(`\u2705 Instance ${name} deleted.`);
}
