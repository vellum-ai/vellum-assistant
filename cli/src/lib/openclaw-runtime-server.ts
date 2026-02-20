import { join } from "path";

export async function buildOpenclawRuntimeServer(): Promise<string> {
  const serverSource = await Bun.file(join(import.meta.dir, "..", "adapters", "openclaw-http-server.ts")).text();

  return `
cat > /opt/openclaw-runtime-server.ts << 'RUNTIME_SERVER_EOF'
${serverSource}
RUNTIME_SERVER_EOF

mkdir -p "\$HOME/.vellum"
nohup bun run /opt/openclaw-runtime-server.ts >> "\$HOME/.vellum/http-gateway.log" 2>&1 &
echo "OpenClaw runtime server started (PID: \$!)"
`;
}
