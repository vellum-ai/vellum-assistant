/** Only allow simple kebab-case keys (e.g. "voice-mode", "ces-tools"). */
const ALLOWED_KEY_RE = /^[a-z0-9][a-z0-9-]*$/;

/**
 * Extract repeatable `--flag key=value` pairs from a CLI arg list.
 *
 * Each `--flag` consumes the next argument as `key=value`. Keys are validated
 * against a kebab-case pattern, then converted to env var names of the form
 * `VELLUM_FLAG_<UPPER_SNAKE>`. All `--flag` pairs are stripped from the
 * returned `remaining` array so downstream parsers never see them.
 */
export function parseFeatureFlagArgs(args: string[]): {
  envVars: Record<string, string>;
  remaining: string[];
} {
  const envVars: Record<string, string> = {};
  const remaining: string[] = [];

  let i = 0;
  while (i < args.length) {
    if (args[i] === "--flag") {
      if (i + 1 >= args.length) {
        console.error("Error: --flag requires a key=value argument");
        process.exit(1);
      }

      const pair = args[i + 1]!;
      const eqIdx = pair.indexOf("=");
      if (eqIdx === -1) {
        console.error(
          `Error: --flag value must be in key=value format, got "${pair}"`,
        );
        process.exit(1);
      }

      const key = pair.slice(0, eqIdx);
      const value = pair.slice(eqIdx + 1);

      if (!ALLOWED_KEY_RE.test(key)) {
        console.error(
          `Error: invalid flag key "${key}". Keys must be kebab-case (e.g. "voice-mode")`,
        );
        process.exit(1);
      }

      const envName = `VELLUM_FLAG_${key.toUpperCase().replace(/-/g, "_")}`;
      envVars[envName] = value;
      i += 2;
    } else {
      remaining.push(args[i]!);
      i += 1;
    }
  }

  return { envVars, remaining };
}

const ENV_FLAG_PREFIX = "VELLUM_FLAG_";

/**
 * Scan `process.env` for ambient `VELLUM_FLAG_*` entries.
 * Returns them as-is (same `Record<string, string>` shape as
 * `parseFeatureFlagArgs().envVars`) so callers can merge both
 * sources with `--flag` args winning over ambient env vars.
 */
export function readAmbientFlagEnvVars(): Record<string, string> {
  const vars: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (key.startsWith(ENV_FLAG_PREFIX) && value !== undefined) {
      vars[key] = value;
    }
  }
  return vars;
}
