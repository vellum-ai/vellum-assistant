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

  test("flushes pre-jail conntrack after installing the NAT REDIRECT", async () => {
    // The sidecar attaches to an already-running assistant netns, so the
    // daemon may have opened a keep-alive provider connection before
    // these rules existed. NAT REDIRECT only rewrites NEW flows and the
    // filter chain accepts ESTABLISHED ones, so that pre-jail connection
    // would egress past mitmproxy unrecorded. Flushing conntrack forces
    // it to be re-evaluated. The flush must come AFTER the REDIRECT is
    // installed — flushing before would just let the connection
    // re-establish on the still-unredirected path.
    const lines = await readScript();
    const redirect = findLine(
      lines,
      "iptables -t nat -A OUTPUT -p tcp --dport 443 -j REDIRECT",
    );
    const flush = findLine(lines, "conntrack -F");

    expect(flush).toBeGreaterThan(redirect);
  });

  test("requires ALLOW_HOSTS so a misconfig fails loud, not silent", async () => {
    // ALLOW_HOSTS is consumed by the addon (proxy-layer allowlist)
    // now, not by this script — but the script keeps the guard as a
    // central fail-loud misconfig check. A sidecar booted without it
    // would let the addon 403 every request once a mock misses. The
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

  test("accepts mitmproxy's own upstream legs so DNS rotation can't strand a flow", async () => {
    // The DNS-rotation fix: instead of resolving ALLOW_HOSTS to IPs
    // once and pinning a per-IP ACCEPT (which goes stale when
    // api.anthropic.com rotates IPs mid-run), the filter table lets
    // mitmproxy ($MITM_UID) reach any IP. mitmproxy is free to dial
    // whatever DNS returns; the hostname allowlist is enforced in the
    // addon. This UID-scoped ACCEPT must land after the DROP policy is
    // the active default so it's a genuine exception to block-by-default.
    const lines = await readScript();
    const policyDrop = findLine(lines, "iptables -P OUTPUT DROP");
    const mitmAccept = findLine(
      lines,
      'iptables -A OUTPUT -m owner --uid-owner "$MITM_UID" -j ACCEPT',
    );

    expect(policyDrop).toBeGreaterThanOrEqual(0);
    expect(mitmAccept).toBeGreaterThan(policyDrop);
  });

  test("does NOT resolve ALLOW_HOSTS to IPs (the stale-per-IP-ACCEPT design is gone)", async () => {
    // Regression guard for the DNS-rotation bug. The old script ran
    // `getent ahostsv4 $host` to resolve each allowlisted host to IPv4s
    // at container start and installed a per-IP ACCEPT. That snapshot
    // went stale when low-TTL hosts (api.anthropic.com) rotated IPs,
    // stranding mitmproxy's upstream connect against the default DROP.
    // Re-introducing any one-shot DNS resolution would bring the bug
    // back, so we assert no EXECUTABLE line resolves hosts or pins a
    // per-IP ACCEPT. Comment lines (which still document the old design
    // for posterity) are stripped first so the doc reference doesn't
    // trip the guard.
    const codeLines = (await readScript()).filter(
      (line) => !line.trimStart().startsWith("#"),
    );
    const code = codeLines.join("\n");
    expect(code).not.toContain("getent");
    expect(code).not.toContain("ahostsv4");
    // No `-d <ip>` style ACCEPT for ALLOW_HOSTS members. The only
    // destination-scoped ACCEPT that survives is the loopback one
    // (127.0.0.0/8), which the test above already pins.
    expect(code).not.toMatch(/--dport 443 -j ACCEPT/);
  });
});
