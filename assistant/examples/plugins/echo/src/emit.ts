/**
 * Shared stderr emitter for the echo plugin's hooks.
 *
 * Files under `src/` are internal helpers — the external-plugin loader does
 * not walk this directory, so it contributes no surface of its own. The
 * `hooks/` files import from here.
 */

export const PLUGIN_NAME = "echo";

/**
 * One line written to stderr per hook invocation. Kept intentionally compact —
 * pino-style JSON so operators can pipe the assistant's stderr through `jq`
 * without reshaping.
 */
export function emit(hook: string, conversationId: string): void {
  const record = { plugin: PLUGIN_NAME, hook, conversationId };
  process.stderr.write(`${JSON.stringify(record)}\n`);
}
