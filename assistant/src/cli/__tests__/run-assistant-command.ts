/**
 * CLI test utility — run an assistant CLI command via the real program,
 * capturing stdout.
 */
export async function runAssistantCommand(...args: string[]): Promise<string> {
  const { buildCliProgram } = await import("../program.js");
  const program = buildCliProgram();
  program.exitOverride();
  program.configureOutput({ writeErr: () => {}, writeOut: () => {} });

  const chunks: string[] = [];
  const originalWrite = process.stdout.write;
  process.stdout.write = ((chunk: string | Uint8Array) => {
    chunks.push(
      typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk),
    );
    return true;
  }) as typeof process.stdout.write;

  try {
    await program.parseAsync(["node", "assistant", ...args]);
  } catch {
    /* commander exit override throws */
  } finally {
    process.stdout.write = originalWrite;
  }

  return chunks.join("");
}
