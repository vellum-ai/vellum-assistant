import { spawn } from "child_process";

import { VALID_REMOTE_HOSTS } from "../lib/constants";
import type { RemoteHost } from "../lib/constants";
import { getActiveProject, instanceExists } from "../lib/gcp";
import { execOutput } from "../lib/step-runner";

interface RetireArgs {
  name: string;
  remote: RemoteHost;
}

function parseArgs(): RetireArgs {
  const args = process.argv.slice(3);
  let name: string | null = null;
  let remote: RemoteHost = "gcp";

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--remote") {
      const next = args[i + 1];
      if (!next || !VALID_REMOTE_HOSTS.includes(next as RemoteHost)) {
        console.error(
          `Error: --remote requires one of: ${VALID_REMOTE_HOSTS.join(", ")}`,
        );
        process.exit(1);
      }
      remote = next as RemoteHost;
      i++;
    } else if (!arg.startsWith("-")) {
      name = arg;
    } else {
      console.error(
        `Error: Unknown argument '${arg}'. Usage: vellum-cli retire <name> [--remote <${VALID_REMOTE_HOSTS.join("|")}>]`,
      );
      process.exit(1);
    }
  }

  if (!name) {
    console.error("Error: Instance name is required.");
    console.error(
      `Usage: vellum-cli retire <name> [--remote <${VALID_REMOTE_HOSTS.join("|")}>]`,
    );
    process.exit(1);
  }

  return { name, remote };
}

async function retireGcp(name: string): Promise<void> {
  const project = process.env.GCP_PROJECT ?? (await getActiveProject());
  const zone = process.env.GCP_DEFAULT_ZONE;
  if (!zone) {
    console.error("Error: GCP_DEFAULT_ZONE environment variable is not set.");
    process.exit(1);
  }

  const exists = await instanceExists(name, project, zone);
  if (!exists) {
    console.warn(
      `⚠️  Instance ${name} not found in GCP (project=${project}, zone=${zone}).`,
    );
    return;
  }

  console.log(`🗑️  Deleting GCP instance ${name}\n`);

  const child = spawn(
    "gcloud",
    [
      "compute",
      "instances",
      "delete",
      name,
      `--project=${project}`,
      `--zone=${zone}`,
    ],
    { stdio: "inherit" },
  );

  await new Promise<void>((resolve, reject) => {
    child.on("close", (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`gcloud instance delete exited with code ${code}`));
      }
    });
    child.on("error", reject);
  });

  console.log(`✅ Instance ${name} deleted.`);
}

async function getAwsInstanceId(
  name: string,
  region: string,
): Promise<string | null> {
  try {
    const output = await execOutput("aws", [
      "ec2",
      "describe-instances",
      "--filters",
      `Name=tag:Name,Values=${name}`,
      "Name=instance-state-name,Values=pending,running,stopping,stopped",
      "--query",
      "Reservations[0].Instances[0].InstanceId",
      "--output",
      "text",
      "--region",
      region,
    ]);
    const id = output.trim();
    return id && id !== "None" ? id : null;
  } catch {
    return null;
  }
}

async function retireAws(name: string): Promise<void> {
  const region = process.env.AWS_REGION ?? process.env.AWS_DEFAULT_REGION;
  if (!region) {
    console.error("Error: AWS_REGION environment variable is not set.");
    process.exit(1);
  }

  const instanceId = await getAwsInstanceId(name, region);
  if (!instanceId) {
    console.warn(
      `⚠️  Instance ${name} not found in AWS (region=${region}).`,
    );
    return;
  }

  console.log(`🗑️  Terminating AWS instance ${name} (${instanceId})\n`);

  const child = spawn(
    "aws",
    [
      "ec2",
      "terminate-instances",
      "--instance-ids",
      instanceId,
      "--region",
      region,
    ],
    { stdio: "inherit" },
  );

  await new Promise<void>((resolve, reject) => {
    child.on("close", (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(
          new Error(
            `aws ec2 terminate-instances exited with code ${code}`,
          ),
        );
      }
    });
    child.on("error", reject);
  });

  console.log(`✅ Instance ${name} (${instanceId}) terminated.`);
}

export async function retire(): Promise<void> {
  const { name, remote } = parseArgs();

  if (remote === "gcp") {
    await retireGcp(name);
    return;
  }

  if (remote === "aws") {
    await retireAws(name);
    return;
  }

  if (remote === "local") {
    console.log(
      "ℹ️  Local instances don't need remote cleanup. Use 'bunx vellum daemon stop' to stop the local daemon.",
    );
    return;
  }

  if (remote === "custom") {
    console.log(
      "ℹ️  Custom instances must be managed directly on the remote host.",
    );
    return;
  }

  console.error(`Error: Remote host '${remote}' is not supported for retire.`);
  process.exit(1);
}
