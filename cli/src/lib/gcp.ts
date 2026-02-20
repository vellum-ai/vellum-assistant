import { spawn } from "child_process";

import { exec, execOutput } from "./step-runner";

export async function getActiveProject(): Promise<string> {
  const output = await execOutput("gcloud", [
    "config",
    "get-value",
    "project",
  ]);
  const project = output.trim();
  if (!project || project === "(unset)") {
    throw new Error(
      "No active GCP project. Run `gcloud config set project <project>` first.",
    );
  }
  return project;
}

export interface FirewallRuleSpec {
  name: string;
  direction: "INGRESS" | "EGRESS";
  action: "ALLOW" | "DENY";
  rules: string;
  sourceRanges?: string;
  destinationRanges?: string;
  targetTags: string;
  description: string;
}

interface FirewallRuleState {
  name: string;
  direction: string;
  allowed: string;
  sourceRanges: string;
  destinationRanges: string;
  targetTags: string;
  description: string;
}

async function describeFirewallRule(
  ruleName: string,
  project: string,
  account?: string,
): Promise<FirewallRuleState | null> {
  try {
    const args = [
      "compute",
      "firewall-rules",
      "describe",
      ruleName,
      `--project=${project}`,
      "--format=json(name,direction,allowed,sourceRanges,destinationRanges,targetTags,description)",
    ];
    if (account) args.push(`--account=${account}`);
    const output = await execOutput("gcloud", args);
    const parsed = JSON.parse(output);
    const allowed = (parsed.allowed ?? [])
      .map((a: { IPProtocol: string; ports?: string[] }) => {
        const ports = a.ports ?? [];
        if (ports.length === 0) {
          return a.IPProtocol;
        }
        return ports.map((p: string) => `${a.IPProtocol}:${p}`).join(",");
      })
      .filter(Boolean)
      .join(",");
    return {
      name: parsed.name ?? "",
      direction: parsed.direction ?? "",
      allowed,
      sourceRanges: (parsed.sourceRanges ?? []).join(","),
      destinationRanges: (parsed.destinationRanges ?? []).join(","),
      targetTags: (parsed.targetTags ?? []).join(","),
      description: parsed.description ?? "",
    };
  } catch {
    return null;
  }
}

function ruleNeedsUpdate(spec: FirewallRuleSpec, state: FirewallRuleState): boolean {
  return (
    spec.direction !== state.direction ||
    spec.rules !== state.allowed ||
    (spec.sourceRanges ?? "") !== state.sourceRanges ||
    (spec.destinationRanges ?? "") !== state.destinationRanges ||
    spec.targetTags !== state.targetTags ||
    spec.description !== state.description
  );
}

async function createFirewallRule(spec: FirewallRuleSpec, project: string, account?: string): Promise<void> {
  const args = [
    "compute",
    "firewall-rules",
    "create",
    spec.name,
    `--project=${project}`,
    `--direction=${spec.direction}`,
    `--action=${spec.action}`,
    `--rules=${spec.rules}`,
    `--target-tags=${spec.targetTags}`,
    `--description=${spec.description}`,
  ];
  if (spec.sourceRanges) {
    args.push(`--source-ranges=${spec.sourceRanges}`);
  }
  if (spec.destinationRanges) {
    args.push(`--destination-ranges=${spec.destinationRanges}`);
  }
  if (account) args.push(`--account=${account}`);
  await exec("gcloud", args);
}

async function deleteFirewallRule(ruleName: string, project: string, account?: string): Promise<void> {
  const args = [
    "compute",
    "firewall-rules",
    "delete",
    ruleName,
    `--project=${project}`,
    "--quiet",
  ];
  if (account) args.push(`--account=${account}`);
  await exec("gcloud", args);
}

export async function syncFirewallRules(
  desiredRules: FirewallRuleSpec[],
  project: string,
  tag: string,
  account?: string,
): Promise<void> {
  let existingNames: string[];
  try {
    const listArgs = [
      "compute",
      "firewall-rules",
      "list",
      `--project=${project}`,
      "--format=json(name,targetTags)",
    ];
    if (account) listArgs.push(`--account=${account}`);
    const output = await execOutput("gcloud", listArgs);
    const allRules = JSON.parse(output) as Array<{ name: string; targetTags?: string[] }>;
    existingNames = allRules
      .filter((r) => r.targetTags?.includes(tag))
      .map((r) => r.name);
  } catch {
    existingNames = [];
  }

  const desiredNames = new Set(desiredRules.map((r) => r.name));

  for (const existingName of existingNames) {
    if (!desiredNames.has(existingName)) {
      console.log(`   🗑️  Deleting stale firewall rule: ${existingName}`);
      await deleteFirewallRule(existingName, project, account);
    }
  }

  for (const spec of desiredRules) {
    const state = await describeFirewallRule(spec.name, project, account);

    if (!state) {
      console.log(`   ➕ Creating firewall rule: ${spec.name}`);
      await createFirewallRule(spec, project, account);
      continue;
    }

    if (ruleNeedsUpdate(spec, state)) {
      console.log(`   🔄 Updating firewall rule: ${spec.name}`);
      await deleteFirewallRule(spec.name, project, account);
      await createFirewallRule(spec, project, account);
      continue;
    }

    console.log(`   ✅ Firewall rule up to date: ${spec.name}`);
  }
}

export async function fetchFirewallRules(
  project: string,
  tag: string,
): Promise<string> {
  const output = await execOutput("gcloud", [
    "compute",
    "firewall-rules",
    "list",
    `--project=${project}`,
    "--format=json",
  ]);
  const rules = JSON.parse(output) as Array<{ targetTags?: string[] }>;
  const filtered = rules.filter((r) => r.targetTags?.includes(tag));
  return JSON.stringify(filtered, null, 2);
}

export interface GcpInstance {
  name: string;
  zone: string;
  externalIp: string | null;
  species: string | null;
}

export async function listAssistantInstances(project: string): Promise<GcpInstance[]> {
  const output = await execOutput("gcloud", [
    "compute",
    "instances",
    "list",
    `--project=${project}`,
    "--filter=labels.vellum-assistant=true",
    "--format=json(name,zone,networkInterfaces[0].accessConfigs[0].natIP,labels)",
  ]);
  const parsed = JSON.parse(output) as Array<{
    name: string;
    zone: string;
    networkInterfaces?: Array<{ accessConfigs?: Array<{ natIP?: string }> }>;
    labels?: Record<string, string>;
  }>;
  return parsed.map((inst) => {
    const zoneParts = (inst.zone ?? "").split("/");
    return {
      name: inst.name,
      zone: zoneParts[zoneParts.length - 1] || "",
      externalIp: inst.networkInterfaces?.[0]?.accessConfigs?.[0]?.natIP ?? null,
      species: inst.labels?.species ?? null,
    };
  });
}

export async function instanceExists(
  instanceName: string,
  project: string,
  zone: string,
  account?: string,
): Promise<boolean> {
  try {
    const args = [
      "compute",
      "instances",
      "describe",
      instanceName,
      `--project=${project}`,
      `--zone=${zone}`,
      "--format=get(name)",
    ];
    if (account) args.push(`--account=${account}`);
    await execOutput("gcloud", args);
    return true;
  } catch {
    return false;
  }
}

export async function sshCommand(
  instanceName: string,
  project: string,
  zone: string,
  command: string,
): Promise<string> {
  return execOutput("gcloud", [
    "compute",
    "ssh",
    instanceName,
    `--project=${project}`,
    `--zone=${zone}`,
    "--quiet",
    "--ssh-flag=-o StrictHostKeyChecking=no",
    "--ssh-flag=-o UserKnownHostsFile=/dev/null",
    "--ssh-flag=-o ConnectTimeout=5",
    "--ssh-flag=-o LogLevel=ERROR",
    `--command=${command}`,
  ]);
}

export async function retireInstance(
  name: string,
  project: string,
  zone: string,
  source?: string,
): Promise<void> {
  const exists = await instanceExists(name, project, zone);
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

  console.log(`\u2705 Instance ${name} deleted.`);
}
