import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, unlinkSync, writeFileSync } from "fs";
import { homedir, tmpdir, userInfo } from "os";
import { join } from "path";

import { buildStartupScript, watchHatching } from "../commands/hatch";
import type { PollResult } from "../commands/hatch";
import { saveAssistantEntry, setActiveAssistant } from "./assistant-config";
import type { AssistantEntry } from "./assistant-config";
import { GATEWAY_PORT } from "./constants";
import type { Species } from "./constants";
import { leaseGuardianToken } from "./guardian-token";
import { generateInstanceName } from "./random-name";
import { exec, execOutput } from "./step-runner";

const KEY_PAIR_NAME = "vellum-assistant";
const DEFAULT_SSH_USER = "admin";
const AWS_INSTANCE_TYPE = "t3.xlarge";
const AWS_DEFAULT_REGION = "us-east-1";

export async function getActiveRegion(): Promise<string> {
  try {
    const output = await execOutput("aws", ["configure", "get", "region"]);
    const region = output.trim();
    if (region) return region;
  } catch {}
  throw new Error(
    "No active AWS region. Set AWS_REGION or run `aws configure set region <region>` first.",
  );
}

export async function getDefaultVpcId(region: string): Promise<string> {
  const output = await execOutput("aws", [
    "ec2",
    "describe-vpcs",
    "--filters",
    "Name=isDefault,Values=true",
    "--query",
    "Vpcs[0].VpcId",
    "--output",
    "text",
    "--region",
    region,
  ]);
  const vpcId = output.trim();
  if (!vpcId || vpcId === "None") {
    throw new Error(
      "No default VPC found. Please create a default VPC or specify one.",
    );
  }
  return vpcId;
}

export async function ensureSecurityGroup(
  groupName: string,
  vpcId: string,
  gatewayPort: number,
  region: string,
): Promise<string> {
  try {
    const output = await execOutput("aws", [
      "ec2",
      "describe-security-groups",
      "--filters",
      `Name=group-name,Values=${groupName}`,
      `Name=vpc-id,Values=${vpcId}`,
      "--query",
      "SecurityGroups[0].GroupId",
      "--output",
      "text",
      "--region",
      region,
    ]);
    const groupId = output.trim();
    if (groupId && groupId !== "None") return groupId;
  } catch {}

  const createOutput = await execOutput("aws", [
    "ec2",
    "create-security-group",
    "--group-name",
    groupName,
    "--description",
    "Security group for vellum-assistant instances",
    "--vpc-id",
    vpcId,
    "--query",
    "GroupId",
    "--output",
    "text",
    "--region",
    region,
  ]);
  const groupId = createOutput.trim();

  await exec("aws", [
    "ec2",
    "authorize-security-group-ingress",
    "--group-id",
    groupId,
    "--protocol",
    "tcp",
    "--port",
    String(gatewayPort),
    "--cidr",
    "0.0.0.0/0",
    "--region",
    region,
  ]);

  await exec("aws", [
    "ec2",
    "authorize-security-group-ingress",
    "--group-id",
    groupId,
    "--protocol",
    "tcp",
    "--port",
    "22",
    "--cidr",
    "0.0.0.0/0",
    "--region",
    region,
  ]);

  return groupId;
}

export async function ensureKeyPair(region: string): Promise<string> {
  const sshDir = join(homedir(), ".ssh");
  const keyPath = join(sshDir, `${KEY_PAIR_NAME}.pem`);

  try {
    await execOutput("aws", [
      "ec2",
      "describe-key-pairs",
      "--key-names",
      KEY_PAIR_NAME,
      "--region",
      region,
    ]);
    if (!existsSync(keyPath)) {
      throw new Error(
        `Key pair '${KEY_PAIR_NAME}' exists in AWS but private key not found at ${keyPath}. ` +
          `Delete it with: aws ec2 delete-key-pair --key-name ${KEY_PAIR_NAME} --region ${region}`,
      );
    }
    return keyPath;
  } catch (error) {
    if (error instanceof Error && error.message.includes("not found at")) {
      throw error;
    }
  }

  if (!existsSync(sshDir)) {
    mkdirSync(sshDir, { recursive: true, mode: 0o700 });
  }
  const output = await execOutput("aws", [
    "ec2",
    "create-key-pair",
    "--key-name",
    KEY_PAIR_NAME,
    "--query",
    "KeyMaterial",
    "--output",
    "text",
    "--region",
    region,
  ]);
  writeFileSync(keyPath, output.trim() + "\n", { mode: 0o600 });
  return keyPath;
}

export async function getLatestDebianAmi(region: string): Promise<string> {
  const output = await execOutput("aws", [
    "ec2",
    "describe-images",
    "--owners",
    "136693071363",
    "--filters",
    "Name=name,Values=debian-11-amd64-*",
    "Name=state,Values=available",
    "--query",
    "sort_by(Images, &CreationDate)[-1].ImageId",
    "--output",
    "text",
    "--region",
    region,
  ]);
  const amiId = output.trim();
  if (!amiId || amiId === "None") {
    throw new Error("Could not find a Debian 11 AMI in this region.");
  }
  return amiId;
}

export async function instanceExistsByName(
  name: string,
  region: string,
): Promise<boolean> {
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
    return output.trim() !== "" && output.trim() !== "None";
  } catch {
    return false;
  }
}

export async function launchInstance(
  name: string,
  amiId: string,
  instanceType: string,
  securityGroupId: string,
  userDataPath: string,
  species: string,
  region: string,
  hatchedBy?: string,
): Promise<string> {
  const blockDeviceMappings = JSON.stringify([
    {
      DeviceName: "/dev/xvda",
      Ebs: { VolumeSize: 50, VolumeType: "gp3" },
    },
  ]);
  const tags = [
    { Key: "Name", Value: name },
    { Key: "vellum-assistant", Value: "true" },
    { Key: "species", Value: species },
  ];
  if (hatchedBy) {
    tags.push({ Key: "hatched-by", Value: hatchedBy });
  }
  const tagSpecifications = JSON.stringify([
    {
      ResourceType: "instance",
      Tags: tags,
    },
  ]);

  const output = await execOutput("aws", [
    "ec2",
    "run-instances",
    "--image-id",
    amiId,
    "--instance-type",
    instanceType,
    "--key-name",
    KEY_PAIR_NAME,
    "--security-group-ids",
    securityGroupId,
    "--user-data",
    `file://${userDataPath}`,
    "--block-device-mappings",
    blockDeviceMappings,
    "--tag-specifications",
    tagSpecifications,
    "--query",
    "Instances[0].InstanceId",
    "--output",
    "text",
    "--region",
    region,
  ]);
  return output.trim();
}

export async function waitForInstanceRunning(
  instanceId: string,
  region: string,
): Promise<void> {
  await exec("aws", [
    "ec2",
    "wait",
    "instance-running",
    "--instance-ids",
    instanceId,
    "--region",
    region,
  ]);
}

export async function getInstancePublicIp(
  instanceId: string,
  region: string,
): Promise<string | null> {
  const output = await execOutput("aws", [
    "ec2",
    "describe-instances",
    "--instance-ids",
    instanceId,
    "--query",
    "Reservations[0].Instances[0].PublicIpAddress",
    "--output",
    "text",
    "--region",
    region,
  ]);
  const ip = output.trim();
  return ip && ip !== "None" ? ip : null;
}

async function awsSshExec(
  ip: string,
  keyPath: string,
  command: string,
): Promise<string> {
  return execOutput("ssh", [
    "-i",
    keyPath,
    "-o",
    "StrictHostKeyChecking=no",
    "-o",
    "UserKnownHostsFile=/dev/null",
    "-o",
    "ConnectTimeout=10",
    "-o",
    "LogLevel=ERROR",
    `${DEFAULT_SSH_USER}@${ip}`,
    command,
  ]);
}

async function pollAwsInstance(
  ip: string,
  keyPath: string,
): Promise<PollResult> {
  try {
    const remoteCmd =
      "L=$(tail -1 /var/log/startup-script.log 2>/dev/null || true); " +
      "S=$(cloud-init status 2>/dev/null | awk '/status:/{print $2}' || echo unknown); " +
      "E=$(cat /var/log/startup-error 2>/dev/null || true); " +
      'printf "%s\\n===HATCH_SEP===\\n%s\\n===HATCH_ERR===\\n%s" "$L" "$S" "$E"';
    const output = await awsSshExec(ip, keyPath, remoteCmd);
    const sepIdx = output.indexOf("===HATCH_SEP===");
    if (sepIdx === -1) {
      return {
        lastLine: output.trim() || null,
        done: false,
        failed: false,
        errorContent: "",
      };
    }
    const errIdx = output.indexOf("===HATCH_ERR===");
    const lastLine = output.substring(0, sepIdx).trim() || null;
    const statusEnd = errIdx === -1 ? undefined : errIdx;
    const status = output
      .substring(sepIdx + "===HATCH_SEP===".length, statusEnd)
      .trim();
    const errorContent =
      errIdx === -1
        ? ""
        : output.substring(errIdx + "===HATCH_ERR===".length).trim();
    const done =
      lastLine !== null && status !== "running" && status !== "pending";
    const failed = errorContent.length > 0 || status === "error";
    return { lastLine, done, failed, errorContent };
  } catch {
    return { lastLine: null, done: false, failed: false, errorContent: "" };
  }
}

export async function hatchAws(
  species: Species,
  detached: boolean,
  name: string | null,
): Promise<void> {
  const startTime = Date.now();
  try {
    const region =
      process.env.AWS_REGION ??
      process.env.AWS_DEFAULT_REGION ??
      (await getActiveRegion().catch(() => AWS_DEFAULT_REGION));
    let instanceName: string;

    instanceName = generateInstanceName(species, name);

    console.log(`\u{1F95A} Creating new assistant: ${instanceName}`);
    console.log(`   Species: ${species}`);
    console.log(`   Cloud: AWS`);
    console.log(`   Region: ${region}`);
    console.log(`   Instance type: ${AWS_INSTANCE_TYPE}`);
    console.log("");

    if (name) {
      if (await instanceExistsByName(name, region)) {
        console.error(
          `Error: Instance name '${name}' is already taken. Please choose a different name.`,
        );
        process.exit(1);
      }
    } else {
      while (await instanceExistsByName(instanceName, region)) {
        console.log(
          `\u26a0\ufe0f  Instance name ${instanceName} already exists, generating a new name...`,
        );
        instanceName = generateInstanceName(species);
      }
    }

    const sshUser = userInfo().username;
    const hatchedBy = process.env.VELLUM_HATCHED_BY;
    const anthropicApiKey = process.env.ANTHROPIC_API_KEY;
    if (!anthropicApiKey) {
      console.error(
        "Error: ANTHROPIC_API_KEY environment variable is not set.",
      );
      process.exit(1);
    }

    const vpcId = await getDefaultVpcId(region);

    console.log("\u{1F512} Ensuring security group...");
    const securityGroupId = await ensureSecurityGroup(
      "vellum-assistant",
      vpcId,
      GATEWAY_PORT,
      region,
    );

    console.log("\u{1F511} Ensuring SSH key pair...");
    const keyPath = await ensureKeyPair(region);

    console.log("\u{1F50D} Finding latest Debian AMI...");
    const amiId = await getLatestDebianAmi(region);

    const startupScript = await buildStartupScript(
      species,
      sshUser,
      anthropicApiKey,
      instanceName,
      "aws",
    );
    const startupScriptPath = join(tmpdir(), `${instanceName}-startup.sh`);
    writeFileSync(startupScriptPath, startupScript);

    console.log("\u{1F528} Launching instance...");
    let instanceId: string;
    try {
      instanceId = await launchInstance(
        instanceName,
        amiId,
        AWS_INSTANCE_TYPE,
        securityGroupId,
        startupScriptPath,
        species,
        region,
        hatchedBy,
      );
    } finally {
      try {
        unlinkSync(startupScriptPath);
      } catch {}
    }

    console.log(`\u2705 Instance ${instanceName} (${instanceId}) launched\n`);

    console.log("\u23f3 Waiting for instance to be running...");
    await waitForInstanceRunning(instanceId, region);

    let externalIp: string | null = null;
    try {
      externalIp = await getInstancePublicIp(instanceId, region);
    } catch {
      console.log(
        "\u26a0\ufe0f  Could not retrieve external IP yet (instance may still be starting)",
      );
    }

    const runtimeUrl = externalIp
      ? `http://${externalIp}:${GATEWAY_PORT}`
      : `http://${instanceName}:${GATEWAY_PORT}`;
    const awsEntry: AssistantEntry = {
      assistantId: instanceName,
      installationId: randomUUID(),
      runtimeUrl,
      cloud: "aws",
      instanceId,
      region,
      species,
      sshUser,
      hatchedAt: new Date().toISOString(),
    };
    saveAssistantEntry(awsEntry);
    setActiveAssistant(instanceName);

    if (detached) {
      console.log("\u{1F680} Startup script is running on the instance...");
      console.log("");
      console.log("\u2705 Assistant is hatching!\n");
      console.log("Instance details:");
      console.log(`  Name: ${instanceName}`);
      console.log(`  Instance ID: ${instanceId}`);
      console.log(`  Region: ${region}`);
      if (externalIp) {
        console.log(`  External IP: ${externalIp}`);
      }
      console.log("");
    } else {
      console.log("   Press Ctrl+C to detach (instance will keep running)");
      console.log("");

      if (externalIp) {
        const ip = externalIp;
        const result = await watchHatching(
          () => pollAwsInstance(ip, keyPath),
          instanceName,
          startTime,
          species,
        );

        if (!result.success) {
          console.log("");
          if (result.errorContent) {
            console.log("📋 Startup error:");
            console.log(`   ${result.errorContent}`);
            console.log("");
          }
          process.exit(1);
        }

        try {
          const tokenData = await leaseGuardianToken(runtimeUrl, instanceName);
          awsEntry.bearerToken = tokenData.accessToken;
          saveAssistantEntry(awsEntry);
        } catch (err) {
          console.warn(
            `\u26a0\ufe0f  Could not lease guardian token: ${err instanceof Error ? err.message : err}`,
          );
        }
      } else {
        console.log(
          "\u26a0\ufe0f  No external IP available for monitoring. Instance is still running.",
        );
        console.log(`   Monitor with: vel logs ${instanceName}`);
        console.log("");
      }

      console.log("Instance details:");
      console.log(`  Name: ${instanceName}`);
      console.log(`  Instance ID: ${instanceId}`);
      console.log(`  Region: ${region}`);
      if (externalIp) {
        console.log(`  External IP: ${externalIp}`);
      }
    }
  } catch (error) {
    console.error(
      "\u274c Error:",
      error instanceof Error ? error.message : error,
    );
    process.exit(1);
  }
}

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
