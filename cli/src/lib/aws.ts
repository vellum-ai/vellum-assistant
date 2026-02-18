import { existsSync, mkdirSync, writeFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";

import { exec, execOutput } from "./step-runner";

const KEY_PAIR_NAME = "vellum-assistant";
const DEFAULT_SSH_USER = "admin";

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
    throw new Error("No default VPC found. Please create a default VPC or specify one.");
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
): Promise<string> {
  const blockDeviceMappings = JSON.stringify([
    {
      DeviceName: "/dev/xvda",
      Ebs: { VolumeSize: 50, VolumeType: "gp3" },
    },
  ]);
  const tagSpecifications = JSON.stringify([
    {
      ResourceType: "instance",
      Tags: [
        { Key: "Name", Value: name },
        { Key: "vellum-assistant", Value: "true" },
        { Key: "species", Value: species },
      ],
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

export { DEFAULT_SSH_USER as AWS_SSH_USER };

export async function awsSshExec(
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
