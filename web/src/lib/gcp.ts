import { FirewallsClient, InstancesClient } from "@google-cloud/compute";
import fs from "fs";
import Handlebars from "handlebars";
import path from "path";

import { GCP_PROJECT_ID } from "@/lib/gcp-config";
import { getStorage } from "@/lib/storage";

const GCS_BUCKET_NAME = process.env.GCS_BUCKET_NAME || "vellum-ai-prod-vellum-assistant";
const GCS_PREFIX_BASE = "vellum-assistant";
const GCP_ZONE = process.env.GCP_ZONE || "us-central1-a";
const GCP_MACHINE_TYPE = process.env.GCP_MACHINE_TYPE || "e2-medium";
const GCP_SERVICE_ACCOUNT = process.env.GCP_SERVICE_ACCOUNT || "nextjs-web@vellum-ai-prod.iam.gserviceaccount.com";

function getGcpCredentials(): { projectId: string } {
  return { projectId: GCP_PROJECT_ID };
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
          description: "Allow HTTP traffic on port 8080 for Vellum assistant servers",
        },
      });
      console.log(`Firewall rule ${VELLY_AGENT_FIREWALL_NAME} created`);
    } else {
      throw error;
    }
  }
}
 
interface TemplateContext {
  assistantId: string;
  assistantName: string;
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

export function generateAssistantFiles(
  assistantId: string,
  assistantName: string,
  options?: { apiKey?: string }
): Record<string, string> {
  const databaseUrl = process.env.DATABASE_URL || "";
  const anthropicApiKey = process.env.ANTHROPIC_API_KEY || "";
  const apiUrl = process.env.APP_URL || "http://localhost:3000";

  const context: TemplateContext = {
    assistantId,
    assistantName,
    databaseUrl,
    anthropicApiKey,
    apiKey: options?.apiKey,
    apiUrl,
  };
  const templateDir = path.join(process.cwd(), "agent-templates");
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

export async function uploadAssistantToGCS(
  assistantId: string,
  assistantName: string,
  options?: { apiKey?: string }
): Promise<{ bucket: string; prefix: string }> {
  const storage = getStorage();
  const bucket = storage.bucket(GCS_BUCKET_NAME);

  const files = generateAssistantFiles(assistantId, assistantName, options);
  const prefix = `${GCS_PREFIX_BASE}/assistants/${assistantId}`;

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
        assistantId,
        assistantName,
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

function getStartupScript(
  gcsBucket: string,
  gcsPrefix: string
): string {
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

echo "Installing browser runtime..." > "$PROGRESS_FILE"
if ! bunx playwright install --with-deps chromium; then
  echo "playwright install failed" > /opt/vellum-agent/setup-error
  echo "[STARTUP ERROR] playwright install failed" >&2
  exit 1
fi

echo "Creating systemd service..." > "$PROGRESS_FILE"

cat > /etc/systemd/system/vellum-agent.service << 'SYSTEMD_EOF'
[Unit]
Description=Vellum Agent
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

// ============================================================================
// AGENT INSTANCE MANAGEMENT
// ============================================================================

export async function createAssistantComputeInstance(
  assistantId: string,
  assistantName: string,
  gcsBucket: string,
  gcsPrefix: string
): Promise<{ instanceName: string; zone: string; machineType: string }> {
  console.log(`[Agent] Creating instance for assistant ${assistantId}`);

  const computeClient = getComputeClient();
  const instanceName = `vellum-agent-${assistantId.slice(0, 8)}`;
  const startupScript = getStartupScript(gcsBucket, gcsPrefix);

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
            value: assistantId,
          },
          {
            key: "agent-name",
            value: assistantName,
          },
        ],
      },
      labels: {
        "vellum-agent": "true",
        "agent-id": assistantId.slice(0, 63).toLowerCase().replace(/[^a-z0-9-]/g, "-"),
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

  return { instanceName, zone: GCP_ZONE, machineType: GCP_MACHINE_TYPE };
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
  assistantId: string,
  content: string
): Promise<{ bucket: string; prefix: string }> {
  const storage = getStorage();
  const bucket = storage.bucket(GCS_BUCKET_NAME);
  const prefix = `${EDITOR_PREFIX}/${assistantId}`;
  const file = bucket.file(`${prefix}/${EDITOR_FILENAME}`);

  await file.save(content, {
    contentType: "text/x-typescript",
    metadata: {
      assistantId,
      createdAt: new Date().toISOString(),
    },
  });

  return { bucket: GCS_BUCKET_NAME, prefix };
}

export async function getEditorPage(assistantId: string): Promise<string | null> {
  const storage = getStorage();
  const bucket = storage.bucket(GCS_BUCKET_NAME);
  const file = bucket.file(`${EDITOR_PREFIX}/${assistantId}/${EDITOR_FILENAME}`);

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
  assistantId: string,
  content: string
): Promise<boolean> {
  const storage = getStorage();
  const bucket = storage.bucket(GCS_BUCKET_NAME);
  const file = bucket.file(`${EDITOR_PREFIX}/${assistantId}/${EDITOR_FILENAME}`);

  try {
    await file.save(content, {
      contentType: "text/x-typescript",
      metadata: {
        assistantId,
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
