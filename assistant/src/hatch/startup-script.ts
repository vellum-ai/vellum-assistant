import { GATEWAY_PORT } from './constants.js';
import type { Species } from './constants.js';
import { buildInterfacesSeed } from './interfaces-seed.js';
import { buildOpenclawRuntimeServer } from './openclaw-runtime-server.js';

const INSTALL_SCRIPT_REMOTE_PATH = '/tmp/vellum-install.sh';

export { INSTALL_SCRIPT_REMOTE_PATH };

function buildTimestampRedirect(): string {
  return `exec > >(while IFS= read -r line; do printf '[%s] %s\\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" "$line"; done > /var/log/startup-script.log) 2>&1`;
}

function buildUserSetup(sshUser: string): string {
  return `
SSH_USER="${sshUser}"
if ! id "$SSH_USER" &>/dev/null; then
  useradd -m -s /bin/bash "$SSH_USER"
fi
SSH_USER_HOME=$(eval echo "~$SSH_USER")
mkdir -p "$SSH_USER_HOME"
export HOME="$SSH_USER_HOME"
`;
}

function buildOwnershipFixup(): string {
  return `
chown -R "$SSH_USER:$SSH_USER" "$SSH_USER_HOME" 2>/dev/null || true
`;
}

export function buildStartupScript(
  species: Species,
  bearerToken: string,
  sshUser: string,
  anthropicApiKey: string,
): string {
  const timestampRedirect = buildTimestampRedirect();
  const userSetup = buildUserSetup(sshUser);
  const ownershipFixup = buildOwnershipFixup();

  if (species === 'openclaw') {
    const runtimeServer = buildOpenclawRuntimeServer();
    return `#!/bin/bash
set -e

${timestampRedirect}

trap 'EXIT_CODE=\$?; if [ \$EXIT_CODE -ne 0 ]; then echo "Startup script failed with exit code \$EXIT_CODE" > /var/log/startup-error; fi' EXIT
${userSetup}

export OPENCLAW_NPM_LOGLEVEL=verbose
export OPENCLAW_NO_ONBOARD=1
export OPENCLAW_NO_PROMPT=1

echo "=== Pre-install diagnostics ==="
echo "Date: $(date -u)"
echo "Disk:" && df -h / 2>&1 || true
echo "Memory:" && free -m 2>&1 || true
echo "DNS:" && nslookup registry.npmjs.org 2>&1 || true
echo "Registry ping:" && curl -sSf --max-time 10 https://registry.npmjs.org/-/ping 2>&1 || echo "WARN: npm registry unreachable"
echo "=== End pre-install diagnostics ==="

echo "=== Installing build dependencies ==="
apt-get update -y
apt-get install -y build-essential python3 python3-pip git
pip3 install cmake
echo "cmake version: $(cmake --version | head -1)"
echo "=== Build dependencies installed ==="

curl -fsSL https://openclaw.ai/install.sh -o /tmp/openclaw-install.sh
chmod +x /tmp/openclaw-install.sh

set +e
bash /tmp/openclaw-install.sh
INSTALL_EXIT_CODE=\$?
set -e

if [ \$INSTALL_EXIT_CODE -ne 0 ]; then
  echo "=== OpenClaw install failed (exit code: \$INSTALL_EXIT_CODE) ==="
  echo "=== npm debug logs ==="
  find \$HOME/.npm/_logs -name '*.log' -type f 2>/dev/null | sort | while read -r logfile; do
    echo "--- \$logfile ---"
    tail -n 200 "\$logfile" 2>/dev/null || true
  done
  echo "=== Post-failure diagnostics ==="
  echo "Disk:" && df -h / 2>&1 || true
  echo "Memory:" && free -m 2>&1 || true
  echo "node version:" && node --version 2>&1 || echo "node not found"
  echo "npm version:" && npm --version 2>&1 || echo "npm not found"
  echo "npm config:" && npm config list 2>&1 || true
  echo "cmake version:" && cmake --version 2>&1 || echo "cmake not found"
  echo "PATH: \$PATH"
  echo "=== End diagnostics ==="
  exit \$INSTALL_EXIT_CODE
fi

export PATH="\$HOME/.npm-global/bin:\$HOME/.local/bin:/usr/local/bin:\$PATH"

if ! command -v openclaw >/dev/null 2>&1; then
  echo "ERROR: openclaw CLI installation failed. The 'openclaw' command is not available."
  echo "PATH: \$PATH"
  echo "which openclaw:" && which openclaw 2>&1 || true
  echo "npm global bin:" && npm bin -g 2>&1 || true
  echo "npm global list:" && npm list -g --depth=0 2>&1 || true
  exit 1
fi

export XDG_RUNTIME_DIR="/run/user/\$(id -u)"
export DBUS_SESSION_BUS_ADDRESS="unix:path=\$XDG_RUNTIME_DIR/bus"
mkdir -p "\$XDG_RUNTIME_DIR"
loginctl enable-linger root 2>/dev/null || true
systemctl --user daemon-reexec 2>/dev/null || true

if ! command -v bun >/dev/null 2>&1; then
  echo "=== Installing bun ==="
  if ! command -v unzip >/dev/null 2>&1; then
    echo "Installing unzip (required by bun)..."
    apt-get install -y unzip
  fi
  curl -fsSL https://bun.sh/install | bash
  export BUN_INSTALL="\$HOME/.bun"
  export PATH="\$BUN_INSTALL/bin:\$PATH"
  echo "bun version: $(bun --version)"
  echo "=== Bun installed ==="
else
  echo "bun already installed: $(bun --version)"
fi

openclaw gateway install --token ${bearerToken}

mkdir -p /root/.openclaw
openclaw config set env.ANTHROPIC_API_KEY "${anthropicApiKey}"
openclaw config set agents.defaults.model.primary "anthropic/claude-opus-4-6"
openclaw config set gateway.auth.token "${bearerToken}"

echo "=== Starting openclaw gateway at user level ==="
systemctl --user daemon-reload
systemctl --user enable --now openclaw-gateway.service

export PORT=${GATEWAY_PORT}

echo "=== Starting OpenClaw runtime server ==="
${runtimeServer}
echo "=== OpenClaw runtime server started ==="
${ownershipFixup}
`;
  }

  const interfacesSeed = buildInterfacesSeed();

  return `#!/bin/bash
set -e

${timestampRedirect}

trap 'EXIT_CODE=\$?; if [ \$EXIT_CODE -ne 0 ]; then echo "Startup script failed with exit code \$EXIT_CODE" > /var/log/startup-error; fi' EXIT
${userSetup}
ANTHROPIC_API_KEY=${anthropicApiKey}
GATEWAY_RUNTIME_PROXY_ENABLED=true
RUNTIME_PROXY_BEARER_TOKEN=${bearerToken}
${interfacesSeed}
mkdir -p "\$HOME/.vellum"
cat > "\$HOME/.vellum/.env" << DOTENV_EOF
ANTHROPIC_API_KEY=\$ANTHROPIC_API_KEY
GATEWAY_RUNTIME_PROXY_ENABLED=\$GATEWAY_RUNTIME_PROXY_ENABLED
RUNTIME_PROXY_BEARER_TOKEN=\$RUNTIME_PROXY_BEARER_TOKEN
INTERFACES_SEED_DIR=\$INTERFACES_SEED_DIR
DOTENV_EOF

mkdir -p "\$HOME/.vellum/workspace"
cat > "\$HOME/.vellum/workspace/config.json" << CONFIG_EOF
{
  "logFile": {
    "dir": "\$HOME/.vellum/workspace/data/logs"
  }
}
CONFIG_EOF

${ownershipFixup}

export VELLUM_SSH_USER="\$SSH_USER"
curl -fsSL https://assistant.vellum.ai/install.sh -o ${INSTALL_SCRIPT_REMOTE_PATH}
chmod +x ${INSTALL_SCRIPT_REMOTE_PATH}
source ${INSTALL_SCRIPT_REMOTE_PATH}
`;
}
