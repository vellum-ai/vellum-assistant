import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import {
  ensureLocalCA,
  getCAPath,
  issueLeafCert,
} from "../outbound-proxy/index.js";

let dataDir: string;

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "vellum-certs-test-"));
});

afterAll(async () => {
  await rm(dataDir, { recursive: true, force: true });
});

describe("ensureLocalCA", () => {
  test("creates CA cert and key with correct permissions", async () => {
    await ensureLocalCA(dataDir);

    const caDir = join(dataDir, "proxy-ca");
    const certStat = await stat(join(caDir, "ca.pem"));
    const keyStat = await stat(join(caDir, "ca-key.pem"));

    expect(certStat.isFile()).toBe(true);
    expect(keyStat.isFile()).toBe(true);

    // Check permissions (mask with 0o777 to get just the permission bits)
    expect(keyStat.mode & 0o777).toBe(0o600);
    expect(certStat.mode & 0o777).toBe(0o644);
  });

  test("is idempotent — repeated calls do not regenerate", async () => {
    const caDir = join(dataDir, "proxy-ca");
    const certBefore = await readFile(join(caDir, "ca.pem"), "utf-8");
    const keyBefore = await readFile(join(caDir, "ca-key.pem"), "utf-8");

    await ensureLocalCA(dataDir);

    const certAfter = await readFile(join(caDir, "ca.pem"), "utf-8");
    const keyAfter = await readFile(join(caDir, "ca-key.pem"), "utf-8");

    expect(certAfter).toBe(certBefore);
    expect(keyAfter).toBe(keyBefore);
  });
});

describe("issueLeafCert", () => {
  const HOSTNAME = "example.com";

  test("generates a leaf cert for a hostname", async () => {
    const caDir = join(dataDir, "proxy-ca");
    const result = await issueLeafCert(caDir, HOSTNAME);

    expect(result.cert).toContain("BEGIN CERTIFICATE");
    expect(result.key).toContain("BEGIN");

    // Verify the issued files exist on disk
    const issuedDir = join(caDir, "issued");
    const certStat_ = await stat(join(issuedDir, `${HOSTNAME}.pem`));
    const keyStat_ = await stat(join(issuedDir, `${HOSTNAME}-key.pem`));
    expect(certStat_.isFile()).toBe(true);
    expect(keyStat_.isFile()).toBe(true);
  });

  test("returns cached cert on repeated calls", async () => {
    const caDir = join(dataDir, "proxy-ca");
    const first = await issueLeafCert(caDir, HOSTNAME);
    const second = await issueLeafCert(caDir, HOSTNAME);

    expect(second.cert).toBe(first.cert);
    expect(second.key).toBe(first.key);
  });

  test("generates different certs for different hostnames", async () => {
    const caDir = join(dataDir, "proxy-ca");
    const certA = await issueLeafCert(caDir, "a.example.com");
    const certB = await issueLeafCert(caDir, "b.example.com");

    expect(certA.cert).not.toBe(certB.cert);
    expect(certA.key).not.toBe(certB.key);
  }, 15_000);
});

describe("getCAPath", () => {
  test("returns the correct path to the CA cert", () => {
    const result = getCAPath("/some/data/dir");
    expect(result).toBe("/some/data/dir/proxy-ca/ca.pem");
  });
});
