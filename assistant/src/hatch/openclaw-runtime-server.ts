import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ADAPTER_PATH = join(import.meta.dir, 'resources', 'openclaw-http-server.ts');

export function buildOpenclawRuntimeServer(): string {
  const serverSource = readFileSync(ADAPTER_PATH, 'utf-8');

  return `
cat > /opt/openclaw-runtime-server.ts << 'RUNTIME_SERVER_EOF'
${serverSource}
RUNTIME_SERVER_EOF

mkdir -p "\\$HOME/.vellum"
nohup bun run /opt/openclaw-runtime-server.ts >> "\\$HOME/.vellum/http-gateway.log" 2>&1 &
echo "OpenClaw runtime server started (PID: \\$!)"
`;
}
