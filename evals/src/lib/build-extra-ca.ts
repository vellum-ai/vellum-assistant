/**
 * Extra-CA injection for image builds behind a TLS-intercepting egress proxy.
 *
 * Some sandboxed environments (Claude Code on the web, certain CI setups)
 * route all outbound traffic — including a `docker build`'s package fetches
 * (PyPI, the npm registry, bun.sh) — through a proxy that re-signs TLS with
 * its own CA. The host trusts that CA, but freshly built images don't, so
 * every in-build HTTPS fetch fails certificate validation
 * (`UnknownIssuer` / `SELF_SIGNED_CERT_IN_CHAIN`).
 *
 * The proxy CA is public (a certificate, not a key), so the safe fix is to
 * make the build trust it too. We pass the CA(s) to the Dockerfile as a
 * base64 build arg (`EGRESS_PROXY_CA_B64`) and the Dockerfile injects them
 * into the image's trust store. When no such CA is present (a normal dev
 * machine), this returns nothing and the whole mechanism is a no-op.
 *
 * Kept as a self-contained copy (mirrors `cli/src/lib/build-extra-ca.ts`) so
 * the evals workspace stays decoupled from the CLI package.
 */
import { readFileSync, readdirSync } from "fs";
import { join } from "path";

/** Build-arg name read by every Dockerfile that fetches over HTTPS. */
export const EGRESS_PROXY_CA_BUILD_ARG = "EGRESS_PROXY_CA_B64";

/**
 * Directory where Debian-family hosts (and the Claude web sandbox) drop
 * admin-installed extra CAs. Absent on most dev machines.
 */
const EXTRA_CA_DIR = "/usr/local/share/ca-certificates";

function collectExtraCaPems(): string[] {
  if (process.env.VELLUM_BUILD_NO_EXTRA_CA === "1") return [];

  const paths: string[] = [];
  const override = process.env.VELLUM_BUILD_EXTRA_CA_FILE;
  if (override) paths.push(override);
  try {
    for (const entry of readdirSync(EXTRA_CA_DIR)) {
      if (entry.endsWith(".crt")) paths.push(join(EXTRA_CA_DIR, entry));
    }
  } catch {
    // EXTRA_CA_DIR doesn't exist — normal on most hosts. No-op.
  }

  const pems: string[] = [];
  for (const path of paths) {
    try {
      const pem = readFileSync(path, "utf8");
      if (pem.includes("BEGIN CERTIFICATE")) pems.push(pem.trim());
    } catch {
      // Unreadable / missing override path — skip.
    }
  }
  return pems;
}

/**
 * Base64 of the concatenated extra-CA PEM bundle, or `undefined` when there
 * are none — meaning "omit the build arg" so builds on machines without a
 * proxy CA are byte-for-byte unaffected.
 */
export function extraCaBuildArgValue(): string | undefined {
  const pems = collectExtraCaPems();
  if (pems.length === 0) return undefined;
  return Buffer.from(pems.join("\n") + "\n", "utf8").toString("base64");
}

/**
 * `--build-arg EGRESS_PROXY_CA_B64=<…>` ready to splice into a `docker build`
 * argv, or `[]` when there's no extra CA to inject.
 */
export function extraCaBuildArgs(): string[] {
  const value = extraCaBuildArgValue();
  return value === undefined
    ? []
    : ["--build-arg", `${EGRESS_PROXY_CA_BUILD_ARG}=${value}`];
}
