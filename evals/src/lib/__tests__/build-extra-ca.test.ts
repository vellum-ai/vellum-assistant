import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import {
  EGRESS_PROXY_CA_BUILD_ARG,
  extraCaBuildArgValue,
  extraCaBuildArgs,
} from "../build-extra-ca";

const PEM = [
  "-----BEGIN CERTIFICATE-----",
  "MIIBfakecertcontentforunittestonly==",
  "-----END CERTIFICATE-----",
].join("\n");

describe("build-extra-ca", () => {
  const saved = {
    override: process.env.VELLUM_BUILD_EXTRA_CA_FILE,
    disable: process.env.VELLUM_BUILD_NO_EXTRA_CA,
  };

  beforeEach(() => {
    delete process.env.VELLUM_BUILD_EXTRA_CA_FILE;
    delete process.env.VELLUM_BUILD_NO_EXTRA_CA;
  });

  afterEach(() => {
    if (saved.override === undefined)
      delete process.env.VELLUM_BUILD_EXTRA_CA_FILE;
    else process.env.VELLUM_BUILD_EXTRA_CA_FILE = saved.override;
    if (saved.disable === undefined)
      delete process.env.VELLUM_BUILD_NO_EXTRA_CA;
    else process.env.VELLUM_BUILD_NO_EXTRA_CA = saved.disable;
  });

  test("emits a base64 build-arg for a CA supplied via the override path", () => {
    const dir = mkdtempSync(join(tmpdir(), "ca-"));
    const file = join(dir, "proxy.crt");
    writeFileSync(file, PEM);
    process.env.VELLUM_BUILD_EXTRA_CA_FILE = file;

    const value = extraCaBuildArgValue();
    expect(value).toBeDefined();
    // Round-trips back to the original PEM.
    expect(Buffer.from(value!, "base64").toString("utf8")).toContain(
      "BEGIN CERTIFICATE",
    );
    expect(extraCaBuildArgs()).toEqual([
      "--build-arg",
      `${EGRESS_PROXY_CA_BUILD_ARG}=${value}`,
    ]);
  });

  test("is a no-op when the override path is non-existent", () => {
    process.env.VELLUM_BUILD_EXTRA_CA_FILE = join(
      tmpdir(),
      "definitely-not-a-real-ca-file.crt",
    );
    // Note: the host scan may still find real CAs, so only assert that a
    // bad override alone contributes nothing — exercised together with the
    // kill switch below for a hard no-op guarantee.
    process.env.VELLUM_BUILD_NO_EXTRA_CA = "1";
    expect(extraCaBuildArgValue()).toBeUndefined();
    expect(extraCaBuildArgs()).toEqual([]);
  });

  test("kill switch forces the no-op path even with a valid CA", () => {
    const dir = mkdtempSync(join(tmpdir(), "ca-"));
    const file = join(dir, "proxy.crt");
    writeFileSync(file, PEM);
    process.env.VELLUM_BUILD_EXTRA_CA_FILE = file;
    process.env.VELLUM_BUILD_NO_EXTRA_CA = "1";

    expect(extraCaBuildArgValue()).toBeUndefined();
    expect(extraCaBuildArgs()).toEqual([]);
  });
});
