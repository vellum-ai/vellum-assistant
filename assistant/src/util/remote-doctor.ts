import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export interface RemoteDoctorResult {
  sshHost: string;
  output: string;
  error?: string;
}

export function getSSHHost(): string | null {
  const envHost = process.env.VELLUM_SSH_HOST?.trim();
  if (envHost) return envHost;

  const infoPath = join(homedir(), '.vellum', 'runtime-tunnel.info');
  if (existsSync(infoPath)) {
    try {
      const content = readFileSync(infoPath, 'utf-8');
      const match = content.match(/SSH_HOST="([^"]+)"/);
      if (match) return match[1];
    } catch {
      // ignore read errors
    }
  }

  return null;
}

const DIAGNOSTIC_SCRIPT = `
echo "=== System ==="
uname -a
echo ""
echo "=== Uptime ==="
uptime
echo ""
echo "=== Memory ==="
free -h 2>/dev/null || vm_stat 2>/dev/null || echo "(unavailable)"
echo ""
echo "=== Disk (~/.vellum) ==="
df -h ~/.vellum 2>/dev/null || df -h / 2>/dev/null
echo ""
echo "=== Daemon Process ==="
if [ -f ~/.vellum/vellum.pid ]; then
  PID=$(cat ~/.vellum/vellum.pid)
  echo "PID file: $PID"
  if kill -0 "$PID" 2>/dev/null; then
    echo "Status: running"
    ps -p "$PID" -o pid=,ppid=,%cpu=,%mem=,etime=,args= 2>/dev/null || true
  else
    echo "Status: not running (stale PID file)"
  fi
else
  echo "No PID file found"
  PIDS=$(pgrep -f "bun.*daemon/main" 2>/dev/null || true)
  if [ -n "$PIDS" ]; then
    echo "Found daemon-like processes: $PIDS"
  fi
fi
echo ""
echo "=== Socket ==="
ls -la ~/.vellum/vellum.sock 2>/dev/null || echo "Socket file not found"
echo ""
echo "=== Log File ==="
if [ -f ~/.vellum/data/logs/vellum.log ]; then
  SIZE=$(ls -lh ~/.vellum/data/logs/vellum.log | awk '{print $5}')
  echo "Size: $SIZE"
  echo "--- Recent errors ---"
  grep -i "error\\|fatal\\|panic" ~/.vellum/data/logs/vellum.log 2>/dev/null | tail -5 || echo "(none)"
  echo "--- Last 5 lines ---"
  tail -5 ~/.vellum/data/logs/vellum.log
else
  echo "No log file found"
fi
echo ""
echo "=== Database ==="
ls -lh ~/.vellum/data/db/assistant.db 2>/dev/null || echo "Database file not found"
echo ""
echo "=== Bun ==="
bun --version 2>/dev/null || echo "Not found in PATH"
echo ""
echo "=== Network ==="
curl -sf --connect-timeout 5 -o /dev/null https://api.anthropic.com && echo "api.anthropic.com: reachable" || echo "api.anthropic.com: unreachable"
curl -sf --connect-timeout 5 -o /dev/null https://api.openai.com && echo "api.openai.com: reachable" || echo "api.openai.com: unreachable"
`.trim();

export function runRemoteDoctor(): RemoteDoctorResult {
  const sshHost = getSSHHost();
  if (!sshHost) {
    return {
      sshHost: '(unknown)',
      output: '',
      error: 'No SSH host configured. Set VELLUM_SSH_HOST or start a tunnel with scripts/vellum-runtime-tunnel.sh.',
    };
  }

  const result = spawnSync('ssh', [
    '-o', 'ConnectTimeout=10',
    '-o', 'BatchMode=yes',
    '-o', 'StrictHostKeyChecking=accept-new',
    sshHost,
    'bash', '-s',
  ], {
    input: DIAGNOSTIC_SCRIPT,
    encoding: 'utf-8',
    timeout: 30_000,
  });

  if (result.error) {
    return {
      sshHost,
      output: '',
      error: `SSH failed: ${result.error.message}`,
    };
  }

  if (result.status !== 0) {
    const stderr = result.stderr?.trim();
    return {
      sshHost,
      output: result.stdout || '',
      error: `SSH exited with code ${result.status}${stderr ? `: ${stderr}` : ''}`,
    };
  }

  return {
    sshHost,
    output: result.stdout,
  };
}
