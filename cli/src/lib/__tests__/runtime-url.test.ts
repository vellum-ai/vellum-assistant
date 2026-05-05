import { describe, expect, test } from "bun:test";

import type { AssistantEntry } from "../assistant-config.js";
import {
  resolveRuntimeMigrationUrl,
  resolveRuntimeUrl,
} from "../runtime-url.js";

function makeEntry(
  overrides: Partial<AssistantEntry> & {
    cloud: string;
    runtimeUrl: string;
    assistantId: string;
  },
): Pick<AssistantEntry, "cloud" | "runtimeUrl" | "assistantId"> {
  return {
    cloud: overrides.cloud,
    runtimeUrl: overrides.runtimeUrl,
    assistantId: overrides.assistantId,
  };
}

describe("resolveRuntimeMigrationUrl", () => {
  test("local cloud uses gateway-loopback /v1/migrations/<subpath>", () => {
    const entry = makeEntry({
      cloud: "local",
      runtimeUrl: "http://localhost:7821",
      assistantId: "ast-local-1",
    });
    expect(resolveRuntimeMigrationUrl(entry, "export-to-gcs")).toBe(
      "http://localhost:7821/v1/migrations/export-to-gcs",
    );
    expect(resolveRuntimeMigrationUrl(entry, "import-from-gcs")).toBe(
      "http://localhost:7821/v1/migrations/import-from-gcs",
    );
    expect(resolveRuntimeMigrationUrl(entry, "jobs/job-abc")).toBe(
      "http://localhost:7821/v1/migrations/jobs/job-abc",
    );
  });

  test("docker cloud uses gateway-loopback /v1/migrations/<subpath>", () => {
    const entry = makeEntry({
      cloud: "docker",
      runtimeUrl: "http://localhost:7831",
      assistantId: "ast-docker-1",
    });
    expect(resolveRuntimeMigrationUrl(entry, "export-to-gcs")).toBe(
      "http://localhost:7831/v1/migrations/export-to-gcs",
    );
  });

  test("vellum (platform-managed) cloud uses wildcard-proxy /v1/assistants/<id>/migrations/<subpath>", () => {
    const entry = makeEntry({
      cloud: "vellum",
      runtimeUrl: "https://platform.vellum.ai",
      assistantId: "11111111-2222-3333-4444-555555555555",
    });
    expect(resolveRuntimeMigrationUrl(entry, "export-to-gcs")).toBe(
      "https://platform.vellum.ai/v1/assistants/11111111-2222-3333-4444-555555555555/migrations/export-to-gcs",
    );
    expect(resolveRuntimeMigrationUrl(entry, "import-from-gcs")).toBe(
      "https://platform.vellum.ai/v1/assistants/11111111-2222-3333-4444-555555555555/migrations/import-from-gcs",
    );
    expect(resolveRuntimeMigrationUrl(entry, "jobs/job-xyz")).toBe(
      "https://platform.vellum.ai/v1/assistants/11111111-2222-3333-4444-555555555555/migrations/jobs/job-xyz",
    );
  });

  test("dev platform URL still routes through the wildcard prefix", () => {
    const entry = makeEntry({
      cloud: "vellum",
      runtimeUrl: "https://dev-platform.vellum.ai",
      assistantId: "ast-dev-1",
    });
    expect(resolveRuntimeMigrationUrl(entry, "export-to-gcs")).toBe(
      "https://dev-platform.vellum.ai/v1/assistants/ast-dev-1/migrations/export-to-gcs",
    );
  });

  test("a non-vellum, non-local cloud (e.g. gcp) uses the local-shape URL", () => {
    const entry = makeEntry({
      cloud: "gcp",
      runtimeUrl: "http://10.0.0.5:7821",
      assistantId: "ast-gcp-1",
    });
    expect(resolveRuntimeMigrationUrl(entry, "export-to-gcs")).toBe(
      "http://10.0.0.5:7821/v1/migrations/export-to-gcs",
    );
  });
});

describe("resolveRuntimeUrl", () => {
  test("local cloud uses gateway-loopback /v1/<subpath>", () => {
    const entry = makeEntry({
      cloud: "local",
      runtimeUrl: "http://localhost:7821",
      assistantId: "ast-local-1",
    });
    expect(resolveRuntimeUrl(entry, "identity")).toBe(
      "http://localhost:7821/v1/identity",
    );
  });

  test("docker cloud uses gateway-loopback /v1/<subpath>", () => {
    const entry = makeEntry({
      cloud: "docker",
      runtimeUrl: "http://localhost:7831",
      assistantId: "ast-docker-1",
    });
    expect(resolveRuntimeUrl(entry, "identity")).toBe(
      "http://localhost:7831/v1/identity",
    );
  });

  test("vellum cloud uses wildcard-proxy /v1/assistants/<id>/<subpath>", () => {
    const entry = makeEntry({
      cloud: "vellum",
      runtimeUrl: "https://platform.vellum.ai",
      assistantId: "11111111-2222-3333-4444-555555555555",
    });
    expect(resolveRuntimeUrl(entry, "identity")).toBe(
      "https://platform.vellum.ai/v1/assistants/11111111-2222-3333-4444-555555555555/identity",
    );
  });
});
