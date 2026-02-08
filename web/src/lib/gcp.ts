import { FirewallsClient, InstancesClient } from "@google-cloud/compute";
import fs from "fs";
import Handlebars from "handlebars";
import path from "path";

import { getStorage } from "@/lib/storage";

const GCP_PROJECT_ID = process.env.GCP_PROJECT_ID || "vellum-nonprod";
const GCS_BUCKET_NAME = process.env.GCS_BUCKET_NAME || "vellum-nonprod-dev-django";
const GCS_PREFIX_BASE = "vellum-assistant";
const GCP_ZONE = process.env.GCP_ZONE || "us-central1-a";
const GCP_MACHINE_TYPE = process.env.GCP_MACHINE_TYPE || "e2-medium";
const GCP_SERVICE_ACCOUNT = process.env.GCP_SERVICE_ACCOUNT || "dev-sa@vellum-nonprod.iam.gserviceaccount.com";
const GCP_SA_KEY = process.env.GCP_SA_KEY;

// Prequeue configuration
const PREQUEUE_POOL_SIZE = 1; // Minimum number of prequeued instances to maintain
const PREQUEUE_INSTANCE_PREFIX = "vellum-prequeue";

// Templates are uploaded to GCS by GitHub Actions on merge to main
const GCS_TEMPLATES_PREFIX = `${GCS_PREFIX_BASE}/templates`;

function getGcpCredentials(): { projectId: string; credentials?: object } {
  const config: { projectId: string; credentials?: object } = {
    projectId: GCP_PROJECT_ID,
  };
  if (GCP_SA_KEY) {
    config.credentials = JSON.parse(GCP_SA_KEY);
  }
  return config;
}

function getComputeClient(): InstancesClient {
  const config = getGcpCredentials();
  return new InstancesClient(config);
}

function getFirewallsClient(): FirewallsClient {
  const config = getGcpCredentials();
  return new FirewallsClient(config);
}

const VELLY_AGENT_FIREWALL_NAME = "vellum-agent-allow-http-8080";
const VELLY_AGENT_NETWORK_TAG = "vellum-agent-server";

async function ensureFirewallRuleExists(): Promise<void> {
  const firewallsClient = getFirewallsClient();

  try {
    await firewallsClient.get({
      project: GCP_PROJECT_ID,
      firewall: VELLY_AGENT_FIREWALL_NAME,
    });
    console.log(`Firewall rule ${VELLY_AGENT_FIREWALL_NAME} already exists`);
  } catch (error) {
    const err = error as { code?: number };
    if (err.code === 5 || err.code === 404) {
      console.log(`Creating firewall rule ${VELLY_AGENT_FIREWALL_NAME}`);
      await firewallsClient.insert({
        project: GCP_PROJECT_ID,
        firewallResource: {
          name: VELLY_AGENT_FIREWALL_NAME,
          network: "global/networks/default",
          direction: "INGRESS",
          priority: 1000,
          targetTags: [VELLY_AGENT_NETWORK_TAG],
          allowed: [
            {
              IPProtocol: "tcp",
              ports: ["8080"],
            },
          ],
          sourceRanges: ["0.0.0.0/0"],
          description: "Allow HTTP traffic on port 8080 for Vellum agent servers",
        },
      });
      console.log(`Firewall rule ${VELLY_AGENT_FIREWALL_NAME} created`);
    } else {
      throw error;
    }
  }
}

export type AgentType = "simple" | "vellumclaw";

interface TemplateContext {
  agentId: string;
  agentName: string;
  databaseUrl?: string;
  anthropicApiKey?: string;
  apiKey?: string;
  apiUrl?: string;
}

function readDirectoryRecursive(dirPath: string, basePath: string = ""): string[] {
  const entries = fs.readdirSync(dirPath, { withFileTypes: true });
  const filePaths: string[] = [];

  for (const entry of entries) {
    const relativePath = basePath ? path.join(basePath, entry.name) : entry.name;
    if (entry.isDirectory()) {
      filePaths.push(...readDirectoryRecursive(path.join(dirPath, entry.name), relativePath));
    } else {
      filePaths.push(relativePath);
    }
  }

  return filePaths;
}

export function generateAgentFiles(
  agentId: string,
  agentName: string,
  agentType: AgentType = "simple",
  options?: { apiKey?: string }
): Record<string, string> {
  const databaseUrl = process.env.DATABASE_URL || "";
  const anthropicApiKey = process.env.ANTHROPIC_API_KEY || "";
  const apiUrl = process.env.APP_URL || "http://localhost:3000";
  
  const context: TemplateContext = { 
    agentId, 
    agentName, 
    databaseUrl, 
    anthropicApiKey,
    apiKey: options?.apiKey,
    apiUrl,
  };
  const templateDir = path.join(process.cwd(), "agent-templates", agentType);
  const filePaths = readDirectoryRecursive(templateDir);
  const files: Record<string, string> = {};

  for (const filePath of filePaths) {
    const fullPath = path.join(templateDir, filePath);
    const content = fs.readFileSync(fullPath, "utf-8");
    const template = Handlebars.compile(content);
    const outputName = filePath === "env.template" ? ".env" : filePath;
    files[outputName] = template(context);
  }

  return files;
}

export async function uploadAgentToGCS(
  agentId: string,
  agentName: string,
  agentType: AgentType = "simple",
  options?: { apiKey?: string }
): Promise<{ bucket: string; prefix: string }> {
  const storage = getStorage();
  const bucket = storage.bucket(GCS_BUCKET_NAME);

  const files = generateAgentFiles(agentId, agentName, agentType, options);
  const prefix = `${GCS_PREFIX_BASE}/agents/${agentId}`;

  for (const [filename, content] of Object.entries(files)) {
    const file = bucket.file(`${prefix}/${filename}`);
    await file.save(content, {
      contentType: filename.endsWith(".py")
        ? "text/x-python"
        : filename.endsWith(".ts")
          ? "text/x-typescript"
          : filename.endsWith(".js") || filename.endsWith(".mjs")
            ? "text/javascript"
            : filename.endsWith(".json")
              ? "application/json"
              : filename.endsWith(".yaml") || filename.endsWith(".yml")
                ? "text/yaml"
                : "text/plain",
      metadata: {
        agentId,
        agentName,
        createdAt: new Date().toISOString(),
      },
    });
  }

  return { bucket: GCS_BUCKET_NAME, prefix };
}

/**
 * Upload only agent-specific config (.env) to GCS.
 * Used when activating prequeued instances (templates already downloaded).
 */
export async function uploadAgentConfigToGCS(
  agentId: string,
  agentName: string,
  agentType: AgentType = "simple",
  options?: { apiKey?: string }
): Promise<{ bucket: string; prefix: string }> {
  const storage = getStorage();
  const bucket = storage.bucket(GCS_BUCKET_NAME);

  const databaseUrl = process.env.DATABASE_URL || "";
  const anthropicApiKey = process.env.ANTHROPIC_API_KEY || "";
  const apiUrl = process.env.APP_URL || "http://localhost:3000";
  
  const context: TemplateContext = { 
    agentId, 
    agentName, 
    databaseUrl, 
    anthropicApiKey,
    apiKey: options?.apiKey,
    apiUrl,
  };
  
  // Only process the .env template
  const templateDir = path.join(process.cwd(), "agent-templates", agentType);
  const envTemplatePath = path.join(templateDir, "env.template");
  const prefix = `${GCS_PREFIX_BASE}/agents/${agentId}`;
  
  if (fs.existsSync(envTemplatePath)) {
    const content = fs.readFileSync(envTemplatePath, "utf-8");
    const template = Handlebars.compile(content);
    const envContent = template(context);
    
    const file = bucket.file(`${prefix}/.env`);
    await file.save(envContent, {
      contentType: "text/plain",
      metadata: {
        agentId,
        agentName,
        createdAt: new Date().toISOString(),
      },
    });
  }

  return { bucket: GCS_BUCKET_NAME, prefix };
}

const SETUP_HEALTH_SERVER_SCRIPT = `
python3 -c '
import http.server, json, os
class H(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        if self.path == "/health":
            progress = ""
            error = None
            try:
                with open("/opt/vellum-agent/setup-progress") as f:
                    progress = f.read().strip()
            except Exception:
                pass
            # Check for error state
            if os.path.exists("/opt/vellum-agent/setup-error"):
                try:
                    with open("/opt/vellum-agent/setup-error") as f:
                        error = f.read().strip()
                except Exception:
                    pass
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            if error:
                self.wfile.write(json.dumps({"status": "error", "progress": progress, "error": error}).encode())
            else:
                self.wfile.write(json.dumps({"status": "setting_up", "progress": progress}).encode())
        else:
            self.send_response(404)
            self.end_headers()
    def log_message(self, *a): pass
http.server.HTTPServer(("0.0.0.0", 8080), H).serve_forever()
' &
HEALTH_PID=$!
`;

// Phase 1: Prequeue startup script - installs dependencies and waits
function getPrequeueStartupScript(agentType: AgentType): string {
  if (agentType === "vellumclaw") {
    return `#!/bin/bash

PROGRESS_FILE="/opt/vellum-agent/setup-progress"
READY_FILE="/opt/vellum-agent/prequeue-ready"
ACTIVATE_FILE="/opt/vellum-agent/activate"
mkdir -p /opt/vellum-agent

# Redirect stdout to startup log, stderr to both error log and startup log
exec > /var/log/vellum-agent-startup.log 2> >(tee -a /opt/vellum-agent/error.log >&1)

echo "Preparing environment..." > "$PROGRESS_FILE"
${SETUP_HEALTH_SERVER_SCRIPT}

echo "Installing system dependencies..." > "$PROGRESS_FILE"
apt-get update
apt-get install -y unzip git

# Install bun (HOME must be set for the installer)
export HOME=/root
curl -fsSL https://bun.sh/install | bash
export BUN_INSTALL="$HOME/.bun"
export PATH="$BUN_INSTALL/bin:$PATH"

# Create working directory
mkdir -p /opt/vellum-agent
cd /opt/vellum-agent

# Create top-level data directories
mkdir -p data/inbox data/outbox

# PHASE 1: Download templates from GCS and install dependencies
echo "Downloading template files..." > "$PROGRESS_FILE"
gsutil -m cp -r "gs://${GCS_BUCKET_NAME}/${GCS_TEMPLATES_PREFIX}/vellumclaw/*" .

echo "Installing packages with bun..." > "$PROGRESS_FILE"
if ! bun install; then
  echo "bun install failed" > /opt/vellum-agent/setup-error
  echo "[STARTUP ERROR] bun install failed" >&2
  exit 1
fi

echo "Creating systemd service..." > "$PROGRESS_FILE"

# Create systemd service for the agent (don't start yet)
cat > /etc/systemd/system/vellum-agent.service << 'SYSTEMD_EOF'
[Unit]
Description=Vellum VellumClaw Agent
After=network.target

[Service]
Type=simple
WorkingDirectory=/opt/vellum-agent
ExecStart=/root/.bun/bin/bun run start
Restart=on-failure
RestartSec=10
StandardOutput=append:/var/log/vellum-agent.log
StandardError=append:/var/log/vellum-agent.log
Environment=NODE_ENV=production
Environment=BUN_INSTALL=/root/.bun
Environment=PATH=/root/.bun/bin:/usr/local/bin:/usr/bin:/bin

[Install]
WantedBy=multi-user.target
SYSTEMD_EOF

systemctl daemon-reload
systemctl enable vellum-agent

# Mark as ready and wait for activation
echo "prequeue-ready" > "$PROGRESS_FILE"
touch "$READY_FILE"

echo "Instance prequeued and ready. Waiting for activation signal..."

# Wait for activation signal (poll for activate file or GCS signal)
while [ ! -f "$ACTIVATE_FILE" ]; do
  # Also check GCS for activation signal
  if gsutil -q stat "gs://${GCS_BUCKET_NAME}/${GCS_PREFIX_BASE}/prequeue/$(hostname)/activate" 2>/dev/null; then
    gsutil cp "gs://${GCS_BUCKET_NAME}/${GCS_PREFIX_BASE}/prequeue/$(hostname)/activate" "$ACTIVATE_FILE"
    break
  fi
  sleep 5
done

echo "Activation signal received!"

# PHASE 2: Read activation config and download agent-specific files
source "$ACTIVATE_FILE"

echo "Downloading agent config for $AGENT_ID..." > "$PROGRESS_FILE"
gsutil cp "gs://$GCS_BUCKET/$GCS_PREFIX/.env" .

# Start the service
echo "Starting agent..." > "$PROGRESS_FILE"
kill $HEALTH_PID 2>/dev/null || true
systemctl start vellum-agent

# Clean up prequeue files
rm -f "$READY_FILE" "$ACTIVATE_FILE"

# Give the service a moment to start
sleep 2

# Verify service started
if systemctl is-active --quiet vellum-agent; then
  echo "Agent service started successfully"
  rm -f "$PROGRESS_FILE"
else
  echo "Agent service failed to start" > /opt/vellum-agent/setup-error
  echo "[STARTUP ERROR] Agent service failed to start" >&2
  systemctl status vellum-agent >&2
  exit 1
fi
`;
  }

  // Simple agent type prequeue script
  return `#!/bin/bash

PROGRESS_FILE="/opt/vellum-agent/setup-progress"
READY_FILE="/opt/vellum-agent/prequeue-ready"
ACTIVATE_FILE="/opt/vellum-agent/activate"
mkdir -p /opt/vellum-agent

# Redirect stdout to startup log, stderr to both error log and startup log
exec > /var/log/vellum-agent-startup.log 2> >(tee -a /opt/vellum-agent/error.log >&1)

echo "Preparing environment..." > "$PROGRESS_FILE"
${SETUP_HEALTH_SERVER_SCRIPT}

echo "Installing system dependencies..." > "$PROGRESS_FILE"
curl -LsSf https://astral.sh/uv/install.sh | sh
export PATH="/root/.local/bin:$PATH"

# Create working directory
mkdir -p /opt/vellum-agent
cd /opt/vellum-agent

# PHASE 1: Download templates from GCS and install dependencies
echo "Downloading template files..." > "$PROGRESS_FILE"
gsutil -m cp -r "gs://${GCS_BUCKET_NAME}/${GCS_TEMPLATES_PREFIX}/simple/*" .

echo "Installing Python dependencies..." > "$PROGRESS_FILE"
if ! uv sync; then
  echo "uv sync failed" > /opt/vellum-agent/setup-error
  echo "[STARTUP ERROR] uv sync failed" >&2
  exit 1
fi

echo "Creating systemd service..." > "$PROGRESS_FILE"

cat > /etc/systemd/system/vellum-agent.service << 'SYSTEMD_EOF'
[Unit]
Description=Vellum Simple Agent
After=network.target

[Service]
Type=simple
WorkingDirectory=/opt/vellum-agent
ExecStart=/root/.local/bin/uv run python main.py
Restart=on-failure
RestartSec=10
StandardOutput=append:/var/log/vellum-agent.log
StandardError=append:/var/log/vellum-agent.log
Environment=PATH=/root/.local/bin:/usr/local/bin:/usr/bin:/bin

[Install]
WantedBy=multi-user.target
SYSTEMD_EOF

systemctl daemon-reload
systemctl enable vellum-agent

# Mark as ready and wait for activation
echo "prequeue-ready" > "$PROGRESS_FILE"
touch "$READY_FILE"

echo "Instance prequeued and ready. Waiting for activation signal..."

# Wait for activation signal
while [ ! -f "$ACTIVATE_FILE" ]; do
  if gsutil -q stat "gs://${GCS_BUCKET_NAME}/${GCS_PREFIX_BASE}/prequeue/$(hostname)/activate" 2>/dev/null; then
    gsutil cp "gs://${GCS_BUCKET_NAME}/${GCS_PREFIX_BASE}/prequeue/$(hostname)/activate" "$ACTIVATE_FILE"
    break
  fi
  sleep 5
done

echo "Activation signal received!"

# PHASE 2: Read activation config and download agent-specific files
source "$ACTIVATE_FILE"

echo "Downloading agent config for $AGENT_ID..." > "$PROGRESS_FILE"
gsutil cp "gs://$GCS_BUCKET/$GCS_PREFIX/.env" .

# Start the service
echo "Starting agent..." > "$PROGRESS_FILE"
kill $HEALTH_PID 2>/dev/null || true
systemctl start vellum-agent

rm -f "$READY_FILE" "$ACTIVATE_FILE"

sleep 2

if systemctl is-active --quiet vellum-agent; then
  echo "Agent service started successfully"
  rm -f "$PROGRESS_FILE"
else
  echo "Agent service failed to start" > /opt/vellum-agent/setup-error
  echo "[STARTUP ERROR] Agent service failed to start" >&2
  systemctl status vellum-agent >&2
  exit 1
fi
`;
}

// Original full startup script (for fallback when no prequeued instance available)
function getStartupScript(
  agentType: AgentType,
  gcsBucket: string,
  gcsPrefix: string
): string {
  if (agentType === "vellumclaw") {
    return `#!/bin/bash

PROGRESS_FILE="/opt/vellum-agent/setup-progress"
mkdir -p /opt/vellum-agent

# Redirect stdout to startup log, stderr to both error log and startup log
exec > /var/log/vellum-agent-startup.log 2> >(tee -a /opt/vellum-agent/error.log >&1)

echo "Preparing environment..." > "$PROGRESS_FILE"
${SETUP_HEALTH_SERVER_SCRIPT}

echo "Installing system dependencies..." > "$PROGRESS_FILE"
apt-get update
apt-get install -y unzip git

# Install bun (HOME must be set for the installer)
export HOME=/root
curl -fsSL https://bun.sh/install | bash
export BUN_INSTALL="$HOME/.bun"
export PATH="$BUN_INSTALL/bin:$PATH"

# Create working directory
mkdir -p /opt/vellum-agent
cd /opt/vellum-agent

echo "Downloading agent files..." > "$PROGRESS_FILE"
gsutil -m cp -r gs://${gcsBucket}/${gcsPrefix}/* .

# Create top-level data directories
mkdir -p data/inbox data/outbox

echo "Installing packages with bun..." > "$PROGRESS_FILE"
if ! bun install; then
  echo "bun install failed" > /opt/vellum-agent/setup-error
  echo "[STARTUP ERROR] bun install failed" >&2
  exit 1
fi

echo "Creating systemd service..." > "$PROGRESS_FILE"

# Create systemd service for the agent (runs in background, doesn't block SSH)
cat > /etc/systemd/system/vellum-agent.service << 'SYSTEMD_EOF'
[Unit]
Description=Vellum VellumClaw Agent
After=network.target

[Service]
Type=simple
WorkingDirectory=/opt/vellum-agent
ExecStart=/root/.bun/bin/bun run start
Restart=on-failure
RestartSec=10
StandardOutput=append:/var/log/vellum-agent.log
StandardError=append:/var/log/vellum-agent.log
Environment=NODE_ENV=production
Environment=BUN_INSTALL=/root/.bun
Environment=PATH=/root/.bun/bin:/usr/local/bin:/usr/bin:/bin

[Install]
WantedBy=multi-user.target
SYSTEMD_EOF

# Reload systemd, enable and start the service
systemctl daemon-reload
systemctl enable vellum-agent
systemctl start vellum-agent

echo "Starting agent..." > "$PROGRESS_FILE"
kill $HEALTH_PID 2>/dev/null || true

# Give the service a moment to start
sleep 2

# Verify service started
if systemctl is-active --quiet vellum-agent; then
  echo "Agent service started successfully"
  rm -f "$PROGRESS_FILE"
else
  echo "Agent service failed to start" > /opt/vellum-agent/setup-error
  echo "[STARTUP ERROR] Agent service failed to start" >&2
  systemctl status vellum-agent >&2
  exit 1
fi
`;
  }

  return `#!/bin/bash

PROGRESS_FILE="/opt/vellum-agent/setup-progress"
mkdir -p /opt/vellum-agent

# Redirect stdout to startup log, stderr to both error log and startup log
exec > /var/log/vellum-agent-startup.log 2> >(tee -a /opt/vellum-agent/error.log >&1)

echo "Preparing environment..." > "$PROGRESS_FILE"
${SETUP_HEALTH_SERVER_SCRIPT}

echo "Installing system dependencies..." > "$PROGRESS_FILE"
curl -LsSf https://astral.sh/uv/install.sh | sh
export PATH="/root/.local/bin:$PATH"

# Create working directory
mkdir -p /opt/vellum-agent
cd /opt/vellum-agent

echo "Downloading agent files..." > "$PROGRESS_FILE"
gsutil -m cp -r gs://${gcsBucket}/${gcsPrefix}/* .

echo "Installing Python dependencies..." > "$PROGRESS_FILE"
if ! uv sync; then
  echo "uv sync failed" > /opt/vellum-agent/setup-error
  echo "[STARTUP ERROR] uv sync failed" >&2
  exit 1
fi

echo "Creating systemd service..." > "$PROGRESS_FILE"

# Create systemd service for the agent (runs in background, doesn't block SSH)
cat > /etc/systemd/system/vellum-agent.service << 'SYSTEMD_EOF'
[Unit]
Description=Vellum Simple Agent
After=network.target

[Service]
Type=simple
WorkingDirectory=/opt/vellum-agent
ExecStart=/root/.local/bin/uv run python main.py
Restart=on-failure
RestartSec=10
StandardOutput=append:/var/log/vellum-agent.log
StandardError=append:/var/log/vellum-agent.log
Environment=PATH=/root/.local/bin:/usr/local/bin:/usr/bin:/bin

[Install]
WantedBy=multi-user.target
SYSTEMD_EOF

# Reload systemd, enable and start the service
systemctl daemon-reload
systemctl enable vellum-agent
systemctl start vellum-agent

echo "Starting agent..." > "$PROGRESS_FILE"
kill $HEALTH_PID 2>/dev/null || true

# Give the service a moment to start
sleep 2

# Verify service started
if systemctl is-active --quiet vellum-agent; then
  echo "Agent service started successfully"
  rm -f "$PROGRESS_FILE"
else
  echo "Agent service failed to start" > /opt/vellum-agent/setup-error
  echo "[STARTUP ERROR] Agent service failed to start" >&2
  systemctl status vellum-agent >&2
  exit 1
fi
`;
}

// ============================================================================
// PREQUEUE MANAGEMENT
// ============================================================================

export interface PrequeuedInstance {
  instanceName: string;
  zone: string;
  agentType: AgentType;
  status: string;
  createdAt: string;
  ready: boolean;
}

/**
 * Create a prequeued instance that's ready to be assigned to an agent
 */
export async function createPrequeuedInstance(
  agentType: AgentType = "vellumclaw"
): Promise<{ instanceName: string; zone: string }> {
  const computeClient = getComputeClient();
  const instanceId = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const instanceName = `${PREQUEUE_INSTANCE_PREFIX}-${agentType}-${instanceId}`;

  console.log(`[Prequeue] Creating prequeued instance: ${instanceName}`);

  const startupScript = getPrequeueStartupScript(agentType);

  const [operation] = await computeClient.insert({
    project: GCP_PROJECT_ID,
    zone: GCP_ZONE,
    instanceResource: {
      name: instanceName,
      machineType: `zones/${GCP_ZONE}/machineTypes/${GCP_MACHINE_TYPE}`,
      disks: [
        {
          boot: true,
          autoDelete: true,
          initializeParams: {
            sourceImage: "projects/debian-cloud/global/images/family/debian-12",
            diskSizeGb: "10",
          },
        },
      ],
      networkInterfaces: [
        {
          network: "global/networks/default",
          accessConfigs: [
            {
              name: "External NAT",
              type: "ONE_TO_ONE_NAT",
            },
          ],
        },
      ],
      serviceAccounts: [
        {
          email: GCP_SERVICE_ACCOUNT,
          scopes: ["https://www.googleapis.com/auth/cloud-platform"],
        },
      ],
      metadata: {
        items: [
          {
            key: "startup-script",
            value: startupScript,
          },
          {
            key: "prequeue",
            value: "true",
          },
          {
            key: "agent-type",
            value: agentType,
          },
        ],
      },
      labels: {
        "vellum-prequeue": "true",
        "agent-type": agentType,
      },
      tags: {
        items: [VELLY_AGENT_NETWORK_TAG],
      },
    },
  });

  if (operation.latestResponse) {
    console.log(`[Prequeue] Creating instance ${instanceName} in ${GCP_ZONE}`);
  }

  await ensureFirewallRuleExists();

  return { instanceName, zone: GCP_ZONE };
}

/**
 * List all prequeued instances
 */
export async function listPrequeuedInstances(): Promise<PrequeuedInstance[]> {
  const computeClient = getComputeClient();
  const instances: PrequeuedInstance[] = [];

  try {
    const [instanceList] = await computeClient.list({
      project: GCP_PROJECT_ID,
      zone: GCP_ZONE,
      filter: 'labels.vellum-prequeue="true"',
    });

    for (const instance of instanceList || []) {
      if (!instance.name) continue;

      const agentTypeLabel = instance.labels?.["agent-type"] || "vellumclaw";
      const creationTimestamp = instance.creationTimestamp || new Date().toISOString();

      // Check if instance is ready by looking at its health endpoint
      let ready = false;
      if (instance.status === "RUNNING") {
        const ip = instance.networkInterfaces?.[0]?.accessConfigs?.[0]?.natIP;
        if (ip) {
          try {
            const response = await fetch(`http://${ip}:8080/health`, {
              signal: AbortSignal.timeout(3000),
            });
            if (response.ok) {
              const data = await response.json();
              ready = data.progress === "prequeue-ready";
            }
          } catch {
            // Instance not ready yet
          }
        }
      }

      instances.push({
        instanceName: instance.name,
        zone: GCP_ZONE,
        agentType: agentTypeLabel as AgentType,
        status: instance.status || "UNKNOWN",
        createdAt: creationTimestamp,
        ready,
      });
    }
  } catch (error) {
    console.error("[Prequeue] Error listing instances:", error);
  }

  return instances;
}

/**
 * Get an available (ready) prequeued instance
 */
export async function getAvailablePrequeuedInstance(
  agentType: AgentType = "vellumclaw"
): Promise<PrequeuedInstance | null> {
  const instances = await listPrequeuedInstances();

  // Find a ready instance of the right type
  const available = instances.find(
    (i) => i.ready && i.agentType === agentType && i.status === "RUNNING"
  );

  if (available) {
    console.log(`[Prequeue] Found available instance: ${available.instanceName}`);
  } else {
    console.log(`[Prequeue] No available prequeued instances for type: ${agentType}`);
  }

  return available || null;
}

/**
 * Activate a prequeued instance for a specific agent
 */
export async function activatePrequeuedInstance(
  instanceName: string,
  agentId: string,
  agentName: string,
  gcsBucket: string,
  gcsPrefix: string
): Promise<boolean> {
  console.log(`[Prequeue] Activating instance ${instanceName} for agent ${agentId}`);

  const storage = getStorage();
  const bucket = storage.bucket(GCS_BUCKET_NAME);

  // Create activation signal file in GCS
  const activateContent = `#!/bin/bash
export AGENT_ID="${agentId}"
export AGENT_NAME="${agentName}"
export GCS_BUCKET="${gcsBucket}"
export GCS_PREFIX="${gcsPrefix}"
`;

  const activateFile = bucket.file(`${GCS_PREFIX_BASE}/prequeue/${instanceName}/activate`);
  await activateFile.save(activateContent, {
    contentType: "text/x-shellscript",
  });

  console.log(`[Prequeue] Activation signal uploaded for ${instanceName}`);

  // Update instance labels to mark it as assigned
  const computeClient = getComputeClient();

  try {
    // Get current instance to get label fingerprint
    const [instance] = await computeClient.get({
      project: GCP_PROJECT_ID,
      zone: GCP_ZONE,
      instance: instanceName,
    });

    // Update labels
    await computeClient.setLabels({
      project: GCP_PROJECT_ID,
      zone: GCP_ZONE,
      instance: instanceName,
      instancesSetLabelsRequestResource: {
        labels: {
          ...instance.labels,
          "vellum-prequeue": "false",
          "vellum-agent": "true",
          "agent-id": agentId.slice(0, 63).toLowerCase().replace(/[^a-z0-9-]/g, "-"),
        },
        labelFingerprint: instance.labelFingerprint,
      },
    });

    // Update metadata to add agent info
    const currentMetadata = instance.metadata?.items || [];
    const newMetadata = currentMetadata.filter(
      (item) => item.key !== "prequeue" && item.key !== "agent-id" && item.key !== "agent-name"
    );
    newMetadata.push(
      { key: "agent-id", value: agentId },
      { key: "agent-name", value: agentName }
    );

    await computeClient.setMetadata({
      project: GCP_PROJECT_ID,
      zone: GCP_ZONE,
      instance: instanceName,
      metadataResource: {
        items: newMetadata,
        fingerprint: instance.metadata?.fingerprint,
      },
    });

    console.log(`[Prequeue] Instance ${instanceName} activated and relabeled`);
    return true;
  } catch (error) {
    console.error(`[Prequeue] Error activating instance ${instanceName}:`, error);
    return false;
  }
}

/**
 * Ensure the prequeue pool has minimum instances
 */
export async function ensurePrequeuePool(
  agentType: AgentType = "vellumclaw",
  minSize: number = PREQUEUE_POOL_SIZE
): Promise<{ created: number; available: number }> {
  const instances = await listPrequeuedInstances();
  const typeInstances = instances.filter((i) => i.agentType === agentType);

  // Count instances that are ready or still starting up
  const activeCount = typeInstances.filter(
    (i) => i.status === "RUNNING" || i.status === "STAGING" || i.status === "PROVISIONING"
  ).length;

  const toCreate = Math.max(0, minSize - activeCount);

  console.log(
    `[Prequeue] Pool status for ${agentType}: ${activeCount} active, need ${minSize}, creating ${toCreate}`
  );

  let created = 0;
  for (let i = 0; i < toCreate; i++) {
    try {
      await createPrequeuedInstance(agentType);
      created++;
    } catch (error) {
      console.error(`[Prequeue] Error creating instance:`, error);
    }
  }

  return { created, available: activeCount + created };
}

/**
 * Clean up old/stale prequeued instances
 */
export async function cleanupStalePrequeueInstances(maxAgeHours: number = 24): Promise<number> {
  const instances = await listPrequeuedInstances();
  const now = Date.now();
  const maxAgeMs = maxAgeHours * 60 * 60 * 1000;
  let deleted = 0;

  for (const instance of instances) {
    const age = now - new Date(instance.createdAt).getTime();
    if (age > maxAgeMs) {
      console.log(`[Prequeue] Deleting stale instance: ${instance.instanceName} (age: ${Math.round(age / 1000 / 60 / 60)}h)`);
      const success = await deleteInstance(instance.instanceName, instance.zone);
      if (success) deleted++;
    }
  }

  return deleted;
}

// ============================================================================
// AGENT INSTANCE MANAGEMENT (updated to use prequeue)
// ============================================================================

export async function createAgentComputeInstance(
  agentId: string,
  agentName: string,
  gcsBucket: string,
  gcsPrefix: string,
  agentType: AgentType = "simple"
): Promise<{ instanceName: string; zone: string; machineType: string; fromPrequeue: boolean }> {
  // Try to use a prequeued instance first
  const prequeued = await getAvailablePrequeuedInstance(agentType);

  if (prequeued) {
    console.log(`[Agent] Using prequeued instance: ${prequeued.instanceName}`);

    const activated = await activatePrequeuedInstance(
      prequeued.instanceName,
      agentId,
      agentName,
      gcsBucket,
      gcsPrefix
    );

    if (activated) {
      // Trigger pool replenishment asynchronously
      ensurePrequeuePool(agentType).catch((err) =>
        console.error("[Prequeue] Error replenishing pool:", err)
      );

      return {
        instanceName: prequeued.instanceName,
        zone: prequeued.zone,
        machineType: GCP_MACHINE_TYPE,
        fromPrequeue: true,
      };
    }

    console.log(`[Agent] Failed to activate prequeued instance, falling back to fresh creation`);
  }

  // Fallback: create a fresh instance
  console.log(`[Agent] Creating fresh instance for agent ${agentId}`);

  const computeClient = getComputeClient();
  const instanceName = `vellum-agent-${agentId.slice(0, 8)}`;
  const startupScript = getStartupScript(agentType, gcsBucket, gcsPrefix);

  const [operation] = await computeClient.insert({
    project: GCP_PROJECT_ID,
    zone: GCP_ZONE,
    instanceResource: {
      name: instanceName,
      machineType: `zones/${GCP_ZONE}/machineTypes/${GCP_MACHINE_TYPE}`,
      disks: [
        {
          boot: true,
          autoDelete: true,
          initializeParams: {
            sourceImage: "projects/debian-cloud/global/images/family/debian-12",
            diskSizeGb: "10",
          },
        },
      ],
      networkInterfaces: [
        {
          network: "global/networks/default",
          accessConfigs: [
            {
              name: "External NAT",
              type: "ONE_TO_ONE_NAT",
            },
          ],
        },
      ],
      serviceAccounts: [
        {
          email: GCP_SERVICE_ACCOUNT,
          scopes: ["https://www.googleapis.com/auth/cloud-platform"],
        },
      ],
      metadata: {
        items: [
          {
            key: "startup-script",
            value: startupScript,
          },
          {
            key: "agent-id",
            value: agentId,
          },
          {
            key: "agent-name",
            value: agentName,
          },
        ],
      },
      labels: {
        "vellum-agent": "true",
        "agent-id": agentId.slice(0, 63).toLowerCase().replace(/[^a-z0-9-]/g, "-"),
      },
      tags: {
        items: [VELLY_AGENT_NETWORK_TAG],
      },
    },
  });

  if (operation.latestResponse) {
    console.log(`Creating instance ${instanceName} in ${GCP_ZONE}`);
  }

  await ensureFirewallRuleExists();

  // Trigger pool replenishment asynchronously
  ensurePrequeuePool(agentType).catch((err) =>
    console.error("[Prequeue] Error replenishing pool:", err)
  );

  return { instanceName, zone: GCP_ZONE, machineType: GCP_MACHINE_TYPE, fromPrequeue: false };
}

export async function getInstanceExternalIp(
  instanceName: string,
  zone: string
): Promise<string | null> {
  const computeClient = getComputeClient();

  try {
    const [instance] = await computeClient.get({
      project: GCP_PROJECT_ID,
      zone,
      instance: instanceName,
    });

    const networkInterface = instance.networkInterfaces?.[0];
    const accessConfig = networkInterface?.accessConfigs?.[0];
    return accessConfig?.natIP || null;
  } catch (error) {
    console.error("Error getting instance external IP:", error);
    return null;
  }
}

export async function getInstanceStatus(
  instanceName: string,
  zone: string
): Promise<string | null> {
  const computeClient = getComputeClient();

  try {
    const [instance] = await computeClient.get({
      project: GCP_PROJECT_ID,
      zone,
      instance: instanceName,
    });

    return instance.status || null;
  } catch (error) {
    console.error("Error getting instance status:", error);
    return null;
  }
}

export async function startInstance(
  instanceName: string,
  zone: string
): Promise<boolean> {
  const computeClient = getComputeClient();

  try {
    await computeClient.start({
      project: GCP_PROJECT_ID,
      zone,
      instance: instanceName,
    });
    console.log(`Started instance ${instanceName} in ${zone}`);
    return true;
  } catch (error) {
    console.error("Error starting instance:", error);
    return false;
  }
}

export async function stopInstance(
  instanceName: string,
  zone: string
): Promise<boolean> {
  const computeClient = getComputeClient();

  try {
    await computeClient.stop({
      project: GCP_PROJECT_ID,
      zone,
      instance: instanceName,
    });
    console.log(`Stopped instance ${instanceName} in ${zone}`);
    return true;
  } catch (error) {
    console.error("Error stopping instance:", error);
    return false;
  }
}

export async function deleteInstance(
  instanceName: string,
  zone: string
): Promise<boolean> {
  const computeClient = getComputeClient();

  try {
    await computeClient.delete({
      project: GCP_PROJECT_ID,
      zone,
      instance: instanceName,
    });
    console.log(`Deleted instance ${instanceName} in ${zone}`);
    return true;
  } catch (error) {
    console.error("Error deleting instance:", error);
    return false;
  }
}

const EDITOR_PREFIX = `${GCS_PREFIX_BASE}/editor-pages`;
const EDITOR_FILENAME = "EditorPage.tsx";

export async function uploadEditorPage(
  agentId: string,
  content: string
): Promise<{ bucket: string; prefix: string }> {
  const storage = getStorage();
  const bucket = storage.bucket(GCS_BUCKET_NAME);
  const prefix = `${EDITOR_PREFIX}/${agentId}`;
  const file = bucket.file(`${prefix}/${EDITOR_FILENAME}`);

  await file.save(content, {
    contentType: "text/x-typescript",
    metadata: {
      agentId,
      createdAt: new Date().toISOString(),
    },
  });

  return { bucket: GCS_BUCKET_NAME, prefix };
}

export async function getEditorPage(agentId: string): Promise<string | null> {
  const storage = getStorage();
  const bucket = storage.bucket(GCS_BUCKET_NAME);
  const file = bucket.file(`${EDITOR_PREFIX}/${agentId}/${EDITOR_FILENAME}`);

  try {
    const [exists] = await file.exists();
    if (!exists) {
      return null;
    }
    const [content] = await file.download();
    return content.toString("utf-8");
  } catch (error) {
    console.error("Error fetching editor page from GCS:", error);
    return null;
  }
}

export async function updateEditorPage(
  agentId: string,
  content: string
): Promise<boolean> {
  const storage = getStorage();
  const bucket = storage.bucket(GCS_BUCKET_NAME);
  const file = bucket.file(`${EDITOR_PREFIX}/${agentId}/${EDITOR_FILENAME}`);

  try {
    await file.save(content, {
      contentType: "text/x-typescript",
      metadata: {
        agentId,
        updatedAt: new Date().toISOString(),
      },
    });
    return true;
  } catch (error) {
    console.error("Error updating editor page in GCS:", error);
    return false;
  }
}

export function getDefaultEditorTemplate(): string {
  const templatePath = path.join(
    process.cwd(),
    "editor-templates",
    "default-editor.tsx"
  );
  return fs.readFileSync(templatePath, "utf-8");
}
