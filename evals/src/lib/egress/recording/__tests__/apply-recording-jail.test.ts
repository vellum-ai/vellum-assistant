import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, test } from "bun:test";

/**
 * Regression coverage for `apply-recording-jail.sh`.
 *
 * The shell script is the security boundary for the recording egress
 * jail: it installs the filter + NAT rules that constrain what
 * outbound traffic the assistant container can emit and force the
 * Anthropic-bound traffic through mitmproxy. Misordering or losing a
 * rule here is invisible until a real eval run fails — the previous
 * Tier B QA caught exactly this kind of regression where REDIRECT'd
 * loopback packets were silently dropped by the filter chain (filter
 * OUTPUT `-o lo` doesn't match after the NAT DNAT on colima's kernel).
 *
 * These assertions are deliberately literal: they're guarding the
 * exact rule text + ordering, not the high-level intent. That makes
 * unintentional edits (e.g. dropping the `-d 127.0.0.0/8 -j ACCEPT`
 * rule, or moving it after the DROP policy is no longer the active
 * default) jump out in review.
 */

function scriptPath(): string {
  return resolve(
    dirname(fileURLToPath(import.meta.url)),
    "..",
    "apply-recording-jail.sh",
  );
}

async function readScript(): Promise<string[]> {
  const raw = await readFile(scriptPath(), "utf8");
  return raw.split("\n");
}

function findLine(lines: string[], needle: string): number {
  return lines.findIndex((line) => line.includes(needle));
}

describe("apply-recording-jail.sh", () => {
  test("accepts loopback-destined packets after the OUTPUT DROP policy is set", async () => {
    // The NAT OUTPUT REDIRECT below this rule rewrites the dst to
    // 127.0.0.1:<MITM_PORT>. On colima's macOS Virtualization.Framework
    // kernel, the filter OUTPUT chain's `-o lo` interface match does
    // NOT fire for those DNAT'd packets — they still report -o eth0.
    // Matching by destination IP is the portable workaround.
    const lines = await readScript();
    const policyDrop = findLine(lines, "iptables -P OUTPUT DROP");
    const loopbackDest = findLine(
      lines,
      "iptables -A OUTPUT -d 127.0.0.0/8 -j ACCEPT",
    );
    const redirect = findLine(
      lines,
      "iptables -t nat -A OUTPUT -p tcp --dport 443 -j REDIRECT",
    );

    expect(policyDrop).toBeGreaterThanOrEqual(0);
    expect(loopbackDest).toBeGreaterThan(policyDrop);
    expect(redirect).toBeGreaterThan(loopbackDest);
  });

  test("exempts mitmproxy's own outbound traffic from the NAT REDIRECT", async () => {
    // If this RETURN rule is missing or ordered after the REDIRECT,
    // mitmproxy's own re-emission of the assistant's request gets
    // bounced back to itself and the interception loops infinitely
    // (manifests as EMFILE storm in the sidecar logs).
    const lines = await readScript();
    const exempt = findLine(
      lines,
      'iptables -t nat -A OUTPUT -p tcp --dport 443 -m owner --uid-owner "$MITM_UID" -j RETURN',
    );
    const redirect = findLine(
      lines,
      "iptables -t nat -A OUTPUT -p tcp --dport 443 -j REDIRECT",
    );

    expect(exempt).toBeGreaterThanOrEqual(0);
    expect(redirect).toBeGreaterThan(exempt);
  });

  test("requires ALLOW_HOSTS so a misconfig fails loud, not silent", async () => {
    // A missing ALLOW_HOSTS means no upstream the recording sidecar
    // can reach — running mitmproxy in that state would record
    // nothing and the jail would silently break every eval run. The
    // explicit guard at the top of the script makes that case
    // observable in `docker logs <jail-name>`.
    const lines = await readScript();
    const guardCheck = findLine(lines, 'if [ -z "$ALLOW_HOSTS" ]; then');
    const guardExit = findLine(lines, 'echo "ALLOW_HOSTS is required" >&2');
    const guardExitCode = findLine(lines, "exit 64");

    expect(guardCheck).toBeGreaterThanOrEqual(0);
    expect(guardExit).toBeGreaterThan(guardCheck);
    expect(guardExitCode).toBeGreaterThan(guardExit);
  });
});
