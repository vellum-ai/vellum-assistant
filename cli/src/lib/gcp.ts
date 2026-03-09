import { randomBytes } from "crypto";
import { unlinkSync, writeFileSync } from "fs";
import { tmpdir, userInfo } from "os";
import { join } from "path";

import { saveAssistantEntry, setActiveAssistant } from "./assistant-config";
import type { AssistantEntry } from "./assistant-config";
import { FIREWALL_TAG, GATEWAY_PORT } from "./constants";
import type { Species } from "./constants";
import { generateRandomSuffix } from "./random-name";
import { exec, execOutput } from "./step-runner";

export async function getActiveProject(): Promise<string> {
  const output = await execOutput("gcloud", ["config", "get-value", "project"]);
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

function ruleNeedsUpdate(
  spec: FirewallRuleSpec,
  state: FirewallRuleState,
): boolean {
  return (
    spec.direction !== state.direction ||
    spec.rules !== state.allowed ||
    (spec.sourceRanges ?? "") !== state.sourceRanges ||
    (spec.destinationRanges ?? "") !== state.destinationRanges ||
    spec.targetTags !== state.targetTags ||
    spec.description !== state.description
  );
}

async function createFirewallRule(
  spec: FirewallRuleSpec,
  project: string,
  account?: string,
): Promise<void> {
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

async function deleteFirewallRule(
  ruleName: string,
  project: string,
  account?: string,
): Promise<void> {
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
    const allRules = JSON.parse(output) as Array<{
      name: string;
      targetTags?: string[];
    }>;
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

export async function fetchAndDisplayStartupLogs(
  instanceName: string,
  project: string,
  zone: string,
  account?: string,
): Promise<void> {
  try {
    const remoteCmd =
      'echo "=== Last 50 lines of /var/log/startup-script.log ==="; ' +
      "tail -50 /var/log/startup-script.log 2>/dev/null || echo '(no startup log found)'; " +
      'echo ""; ' +
      'echo "=== /var/log/startup-error ==="; ' +
      "cat /var/log/startup-error 2>/dev/null || echo '(no error file found)'";
    const args = [
      "compute",
      "ssh",
      instanceName,
      `--project=${project}`,
      `--zone=${zone}`,
      "--quiet",
      "--ssh-flag=-o StrictHostKeyChecking=no",
      "--ssh-flag=-o UserKnownHostsFile=/dev/null",
      "--ssh-flag=-o ConnectTimeout=10",
      "--ssh-flag=-o LogLevel=ERROR",
      `--command=${remoteCmd}`,
    ];
    if (account) args.push(`--account=${account}`);
    const output = await execOutput("gcloud", args);
    console.log("📋 Startup logs from instance:");
    for (const line of output.split("\n")) {
      console.log(`   ${line}`);
    }
    console.log("");
  } catch {
    console.log("⚠️  Could not retrieve startup logs from instance");
    console.log("");
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

export interface PollResult {
  lastLine: string | null;
  done: boolean;
  failed: boolean;
  errorContent: string;
}

export interface WatchHatchingResult {
  success: boolean;
  errorContent: string;
}

const INSTALL_SCRIPT_REMOTE_PATH = "/tmp/vellum-install.sh";
const MACHINE_TYPE = "e2-standard-4"; // 4 vCPUs, 16 GB memory

const DESIRED_FIREWALL_RULES: FirewallRuleSpec[] = [
  {
    name: "allow-vellum-assistant-gateway",
    direction: "INGRESS",
    action: "ALLOW",
    rules: `tcp:${GATEWAY_PORT}`,
    sourceRanges: "0.0.0.0/0",
    targetTags: FIREWALL_TAG,
    description: `Allow gateway ingress on port ${GATEWAY_PORT} for vellum-assistant instances`,
  },
  {
    name: "allow-vellum-assistant-egress",
    direction: "EGRESS",
    action: "ALLOW",
    rules: "all",
    destinationRanges: "0.0.0.0/0",
    targetTags: FIREWALL_TAG,
    description: "Allow all egress traffic for vellum-assistant instances",
  },
];

import INSTALL_SCRIPT_CONTENT from "../adapters/install.sh" with { type: "text" };

function resolveInstallScriptPath(): string {
  const tmpPath = join(tmpdir(), `vellum-install-${process.pid}.sh`);
  writeFileSync(tmpPath, INSTALL_SCRIPT_CONTENT, { mode: 0o755 });
  return tmpPath;
}

async function pollInstance(
  instanceName: string,
  project: string,
  zone: string,
  account?: string,
): Promise<PollResult> {
  try {
    const remoteCmd =
      "L=$(tail -1 /var/log/startup-script.log 2>/dev/null || true); " +
      "S=$(systemctl is-active google-startup-scripts.service 2>/dev/null || true); " +
      "E=$(cat /var/log/startup-error 2>/dev/null || true); " +
      'printf "%s\\n===HATCH_SEP===\\n%s\\n===HATCH_ERR===\\n%s" "$L" "$S" "$E"';
    const args = [
      "compute",
      "ssh",
      instanceName,
      `--project=${project}`,
      `--zone=${zone}`,
      "--quiet",
      "--ssh-flag=-o StrictHostKeyChecking=no",
      "--ssh-flag=-o UserKnownHostsFile=/dev/null",
      "--ssh-flag=-o ConnectTimeout=10",
      "--ssh-flag=-o LogLevel=ERROR",
      `--command=${remoteCmd}`,
    ];
    if (account) args.push(`--account=${account}`);
    const output = await execOutput("gcloud", args);
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
      lastLine !== null && status !== "active" && status !== "activating";
    const failed = errorContent.length > 0 || status === "failed";
    return { lastLine, done, failed, errorContent };
  } catch {
    return { lastLine: null, done: false, failed: false, errorContent: "" };
  }
}

async function checkCurlFailure(
  instanceName: string,
  project: string,
  zone: string,
  account?: string,
): Promise<boolean> {
  try {
    const args = [
      "compute",
      "ssh",
      instanceName,
      `--project=${project}`,
      `--zone=${zone}`,
      "--quiet",
      "--ssh-flag=-o StrictHostKeyChecking=no",
      "--ssh-flag=-o UserKnownHostsFile=/dev/null",
      "--ssh-flag=-o ConnectTimeout=10",
      "--ssh-flag=-o LogLevel=ERROR",
      `--command=test -s ${INSTALL_SCRIPT_REMOTE_PATH} && echo EXISTS || echo MISSING`,
    ];
    if (account) args.push(`--account=${account}`);
    const output = await execOutput("gcloud", args);
    return output.trim() === "MISSING";
  } catch {
    return false;
  }
}

async function recoverFromCurlFailure(
  instanceName: string,
  project: string,
  zone: string,
  sshUser: string,
  account?: string,
): Promise<void> {
  const installScriptPath = resolveInstallScriptPath();

  const scpArgs = [
    "compute",
    "scp",
    installScriptPath,
    `${instanceName}:${INSTALL_SCRIPT_REMOTE_PATH}`,
    `--zone=${zone}`,
    `--project=${project}`,
  ];
  if (account) scpArgs.push(`--account=${account}`);
  console.log("\ud83d\udccb Uploading install script to instance...");
  await exec("gcloud", scpArgs);

  const sshArgs = [
    "compute",
    "ssh",
    `${sshUser}@${instanceName}`,
    `--zone=${zone}`,
    `--project=${project}`,
    `--command=source ${INSTALL_SCRIPT_REMOTE_PATH}`,
  ];
  if (account) sshArgs.push(`--account=${account}`);
  console.log("\ud83d\udd27 Running install script on instance...");
  await exec("gcloud", sshArgs);
  try {
    unlinkSync(installScriptPath);
  } catch {}
}

async function fetchRemoteBearerToken(
  instanceName: string,
  project: string,
  zone: string,
  sshUser: string,
  account?: string,
): Promise<string | null> {
  try {
    const remoteCmd =
      'cat ~/.vellum.lock.json 2>/dev/null || cat ~/.vellum.lockfile.json 2>/dev/null || echo "{}"';
    const args = [
      "compute",
      "ssh",
      `${sshUser}@${instanceName}`,
      `--project=${project}`,
      `--zone=${zone}`,
      "--quiet",
      "--ssh-flag=-o StrictHostKeyChecking=no",
      "--ssh-flag=-o UserKnownHostsFile=/dev/null",
      "--ssh-flag=-o ConnectTimeout=10",
      "--ssh-flag=-o LogLevel=ERROR",
      `--command=${remoteCmd}`,
    ];
    if (account) args.push(`--account=${account}`);
    const output = await execOutput("gcloud", args);
    const data = JSON.parse(output.trim());
    const assistants = data.assistants;
    if (Array.isArray(assistants) && assistants.length > 0) {
      const token = assistants[0].bearerToken;
      if (typeof token === "string" && token) {
        return token;
      }
    }
    return null;
  } catch {
    return null;
  }
}

export async function hatchGcp(
  species: Species,
  detached: boolean,
  name: string | null,
  buildStartupScript: (
    species: Species,
    bearerToken: string,
    sshUser: string,
    anthropicApiKey: string,
    instanceName: string,
    cloud: "gcp",
  ) => Promise<string>,
  watchHatching: (
    pollFn: () => Promise<PollResult>,
    instanceName: string,
    startTime: number,
    species: Species,
  ) => Promise<WatchHatchingResult>,
): Promise<void> {
  const startTime = Date.now();
  const account = process.env.GCP_ACCOUNT_EMAIL;

  try {
    const project = process.env.GCP_PROJECT ?? (await getActiveProject());
    let instanceName: string;

    if (name) {
      instanceName = name;
    } else {
      const suffix = generateRandomSuffix();
      instanceName = `${species}-${suffix}`;
    }

    console.log(`\ud83e\udd5a Creating new assistant: ${instanceName}`);
    console.log(`   Species: ${species}`);
    console.log(`   Cloud: GCP`);
    console.log(`   Project: ${project}`);
    const zone = process.env.GCP_DEFAULT_ZONE;
    if (!zone) {
      console.error("Error: GCP_DEFAULT_ZONE environment variable is not set.");
      process.exit(1);
    }

    console.log(`   Zone: ${zone}`);
    console.log(`   Machine type: ${MACHINE_TYPE}`);
    console.log("");

    if (name) {
      if (await instanceExists(name, project, zone, account)) {
        console.error(
          `Error: Instance name '${name}' is already taken. Please choose a different name.`,
        );
        process.exit(1);
      }
    } else {
      while (await instanceExists(instanceName, project, zone, account)) {
        console.log(
          `\u26a0\ufe0f  Instance name ${instanceName} already exists, generating a new name...`,
        );
        const suffix = generateRandomSuffix();
        instanceName = `${species}-${suffix}`;
      }
    }

    const sshUser = userInfo().username;
    const bearerToken = randomBytes(32).toString("hex");
    const hatchedBy = process.env.VELLUM_HATCHED_BY;
    const anthropicApiKey = process.env.ANTHROPIC_API_KEY;
    if (!anthropicApiKey) {
      console.error(
        "Error: ANTHROPIC_API_KEY environment variable is not set.",
      );
      process.exit(1);
    }
    const startupScript = await buildStartupScript(
      species,
      bearerToken,
      sshUser,
      anthropicApiKey,
      instanceName,
      "gcp",
    );
    const startupScriptPath = join(tmpdir(), `${instanceName}-startup.sh`);
    writeFileSync(startupScriptPath, startupScript);

    console.log("\ud83d\udd28 Creating instance with startup script...");
    try {
      const createArgs = [
        "compute",
        "instances",
        "create",
        instanceName,
        `--project=${project}`,
        `--zone=${zone}`,
        `--machine-type=${MACHINE_TYPE}`,
        "--image-family=debian-11",
        "--image-project=debian-cloud",
        "--boot-disk-size=50GB",
        "--boot-disk-type=pd-standard",
        `--metadata-from-file=startup-script=${startupScriptPath}`,
        `--labels=species=${species},vellum-assistant=true${hatchedBy ? `,hatched-by=${hatchedBy.toLowerCase().replace(/[^a-z0-9_-]/g, "_")}` : ""}`,
        "--tags=vellum-assistant",
        "--no-service-account",
        "--no-scopes",
      ];
      if (account) createArgs.push(`--account=${account}`);
      await exec("gcloud", createArgs);
    } finally {
      try {
        unlinkSync(startupScriptPath);
      } catch {}
    }

    console.log("\ud83d\udd12 Syncing firewall rules...");
    await syncFirewallRules(
      DESIRED_FIREWALL_RULES,
      project,
      FIREWALL_TAG,
      account,
    );

    console.log(`\u2705 Instance ${instanceName} created successfully\n`);

    let externalIp: string | null = null;
    try {
      const describeArgs = [
        "compute",
        "instances",
        "describe",
        instanceName,
        `--project=${project}`,
        `--zone=${zone}`,
        "--format=get(networkInterfaces[0].accessConfigs[0].natIP)",
      ];
      if (account) describeArgs.push(`--account=${account}`);
      const ipOutput = await execOutput("gcloud", describeArgs);
      externalIp = ipOutput.trim() || null;
    } catch {
      console.log(
        "\u26a0\ufe0f  Could not retrieve external IP yet (instance may still be starting)",
      );
    }

    const runtimeUrl = externalIp
      ? `http://${externalIp}:${GATEWAY_PORT}`
      : `http://${instanceName}:${GATEWAY_PORT}`;
    const gcpEntry: AssistantEntry = {
      assistantId: instanceName,
      runtimeUrl,
      bearerToken,
      cloud: "gcp",
      project,
      zone,
      species,
      sshUser,
      hatchedAt: new Date().toISOString(),
    };
    saveAssistantEntry(gcpEntry);
    setActiveAssistant(instanceName);

    if (detached) {
      console.log("\ud83d\ude80 Startup script is running on the instance...");
      console.log("");
      console.log("\u2705 Assistant is hatching!\n");
      console.log("Instance details:");
      console.log(`  Name: ${instanceName}`);
      console.log(`  Project: ${project}`);
      console.log(`  Zone: ${zone}`);
      if (externalIp) {
        console.log(`  External IP: ${externalIp}`);
      }
      console.log("");
    } else {
      console.log("   Press Ctrl+C to detach (instance will keep running)");
      console.log("");

      const result = await watchHatching(
        () => pollInstance(instanceName, project, zone, account),
        instanceName,
        startTime,
        species,
      );

      if (!result.success) {
        console.log("");
        if (result.errorContent) {
          console.log("\ud83d\udccb Startup error:");
          console.log(`   ${result.errorContent}`);
          console.log("");
        }

        await fetchAndDisplayStartupLogs(instanceName, project, zone, account);

        if (
          species === "vellum" &&
          (await checkCurlFailure(instanceName, project, zone, account))
        ) {
          const installScriptUrl = `${process.env.VELLUM_ASSISTANT_PLATFORM_URL ?? "https://assistant.vellum.ai"}/install.sh`;
          console.log(
            `\ud83d\udd04 Detected install script curl failure for ${installScriptUrl}, attempting recovery...`,
          );
          await recoverFromCurlFailure(
            instanceName,
            project,
            zone,
            sshUser,
            account,
          );
          console.log("\u2705 Recovery successful!");
        } else {
          process.exit(1);
        }
      }

      const remoteBearerToken = await fetchRemoteBearerToken(
        instanceName,
        project,
        zone,
        sshUser,
        account,
      );
      if (remoteBearerToken) {
        gcpEntry.bearerToken = remoteBearerToken;
        saveAssistantEntry(gcpEntry);
      }

      console.log("Instance details:");
      console.log(`  Name: ${instanceName}`);
      console.log(`  Project: ${project}`);
      console.log(`  Zone: ${zone}`);
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
