// @ts-expect-error -- Bun embed: imports raw file content as a string, not supported by TypeScript
import serverSource from "../adapters/openclaw-http-server.ts" with { type: "text" };

export function buildOpenclawRuntimeServer(): string {

  return `
cat > /opt/openclaw-runtime-server.ts << 'RUNTIME_SERVER_EOF'
${serverSource}
RUNTIME_SERVER_EOF

mkdir -p "\$HOME/.vellum"
nohup bun run /opt/openclaw-runtime-server.ts >> "\$HOME/.vellum/http-gateway.log" 2>&1 &
echo "OpenClaw runtime server started (PID: \$!)"
`;
}
