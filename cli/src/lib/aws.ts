import { exec, execOutput } from "./step-runner";

async function getInstanceIdByName(
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

async function checkAwsCliAvailable(): Promise<boolean> {
  try {
    await execOutput("aws", ["--version"]);
    return true;
  } catch {
    return false;
  }
}

export async function retireInstance(
  name: string,
  region: string,
  source?: string,
): Promise<void> {
  const awsOk = await checkAwsCliAvailable();
  if (!awsOk) {
    throw new Error(
      `Cannot retire AWS instance '${name}': AWS CLI is not installed or not in PATH. ` +
        `Please install the AWS CLI and try again, or terminate the instance manually ` +
        `via the AWS Console (region=${region}).`,
    );
  }

  const instanceId = await getInstanceIdByName(name, region);
  if (!instanceId) {
    console.warn(
      `\u26a0\ufe0f  Instance ${name} not found in AWS (region=${region}).`,
    );
    return;
  }

  if (source) {
    try {
      await exec("aws", [
        "ec2",
        "create-tags",
        "--resources",
        instanceId,
        "--tags",
        `Key=retired-by,Value=${source}`,
        "--region",
        region,
      ]);
    } catch {
      console.warn(`\u26a0\ufe0f  Could not tag instance before termination`);
    }
  }

  console.log(
    `\u{1F5D1}\ufe0f  Terminating AWS instance ${name} (${instanceId})\n`,
  );

  await exec("aws", [
    "ec2",
    "terminate-instances",
    "--instance-ids",
    instanceId,
    "--region",
    region,
  ]);

  console.log(`\u2705 Instance ${name} (${instanceId}) terminated.`);
}
