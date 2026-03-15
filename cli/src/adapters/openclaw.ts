import { GATEWAY_PORT } from "../lib/constants";
import { buildOpenclawRuntimeServer } from "../lib/openclaw-runtime-server";

export async function buildOpenclawStartupScript(
  sshUser: string,
  anthropicApiKey: string,
  timestampRedirect: string,
  userSetup: string,
  ownershipFixup: string,
): Promise<string> {
  const runtimeServer = await buildOpenclawRuntimeServer();

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

set +e
openclaw gateway install
GATEWAY_INSTALL_EXIT=\$?
set -e

if [ \$GATEWAY_INSTALL_EXIT -ne 0 ]; then
  echo "WARN: openclaw gateway install exited with \$GATEWAY_INSTALL_EXIT (expected systemd mismatch), continuing with user-level systemd setup"
fi

OPENCLAW_GW_TOKEN=$(openssl rand -hex 32)
echo -n "\$OPENCLAW_GW_TOKEN" > /tmp/openclaw-gateway-token

mkdir -p /root/.openclaw
openclaw config set env.ANTHROPIC_API_KEY "${anthropicApiKey}"
openclaw config set agents.defaults.model.primary "anthropic/claude-opus-4-6"
openclaw config set gateway.auth.token "\$OPENCLAW_GW_TOKEN"

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
