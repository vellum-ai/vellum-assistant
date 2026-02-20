// Read source file using Bun.file() with string concatenation (not join())
// so Bun's bundler can statically analyze the path and embed the file
// in the compiled binary ($bunfs). The file must also be passed via --embed
// in the bun build --compile invocation.

export async function buildOpenclawRuntimeServer(): Promise<string> {
  try {
    const serverSource = await Bun.file(import.meta.dir + "/../adapters/openclaw-http-server.ts").text();

    return `
cat > /opt/openclaw-runtime-server.ts << 'RUNTIME_SERVER_EOF'
${serverSource}
RUNTIME_SERVER_EOF

mkdir -p "\$HOME/.vellum"
nohup bun run /opt/openclaw-runtime-server.ts >> "\$HOME/.vellum/http-gateway.log" 2>&1 &
echo "OpenClaw runtime server started (PID: \$!)"
`;
  } catch (err) {
    console.warn("⚠️  Could not embed openclaw runtime server (expected in compiled binary without --embed):", (err as Error).message);
    return "# openclaw-runtime-server: skipped (source files not available in compiled binary)";
  }
}
