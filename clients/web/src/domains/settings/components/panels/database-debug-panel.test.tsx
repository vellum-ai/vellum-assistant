import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, waitFor } from "@testing-library/react";
import { createElement, type ReactNode } from "react";

import type { DebugDatabaseGetResponse } from "@/generated/daemon/types.gen";
import { ApiError } from "@/utils/api-errors";

let supportsDebugDatabase = true;
let databasePayload: DebugDatabaseGetResponse | null = {
  ready: true,
  state: "ready",
  failed: [],
  deferred: [],
};
let databaseError: unknown = null;

mock.module("@/assistant/use-active-assistant-id", () => ({
  useActiveAssistantId: () => "assistant-1",
}));

mock.module("@/hooks/use-is-org-ready", () => ({
  useIsOrgReady: () => true,
}));

mock.module("@/lib/backwards-compat/use-supports-debug-database", () => ({
  MIN_VERSION: "0.11.10",
  useSupportsDebugDatabase: () => supportsDebugDatabase,
}));

const actualSdk = await import("@/generated/daemon/sdk.gen");

mock.module("@/generated/daemon/sdk.gen", () => ({
  ...actualSdk,
  debugDatabaseGet: async () => {
    if (databaseError) {
      throw databaseError;
    }
    return { data: databasePayload };
  },
}));

const { DatabaseDebugPanel } = await import("./database-debug-panel");

function Wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return createElement(QueryClientProvider, { client }, children);
}

function renderPanel() {
  return render(
    createElement(Wrapper, null, createElement(DatabaseDebugPanel)),
  );
}

beforeEach(() => {
  supportsDebugDatabase = true;
  databaseError = null;
  databasePayload = {
    ready: true,
    state: "ready",
    failed: [],
    deferred: [],
  };
});

afterEach(() => {
  cleanup();
});

describe("DatabaseDebugPanel", () => {
  test("shows an empty ready state when no migrations have failed", async () => {
    const { findByText } = renderPanel();
    expect(await findByText("Ready")).toBeDefined();
    expect(await findByText("No failed migrations.")).toBeDefined();
  });

  test("lists failed and deferred migrations", async () => {
    databasePayload = {
      ready: false,
      state: "failed",
      reason: "db_migrations_failed",
      failed: [{ name: "flakyStep", error: "transient failure" }],
      deferred: [{ name: "dependentStep", missing: ["flakyStep"] }],
      validationError: "schema mismatch",
    };
    const { findByText } = renderPanel();
    expect(await findByText("Failed")).toBeDefined();
    expect(await findByText("flakyStep")).toBeDefined();
    expect(await findByText("transient failure")).toBeDefined();
    expect(await findByText("dependentStep")).toBeDefined();
    expect(await findByText("Waiting on: flakyStep")).toBeDefined();
    expect(await findByText("schema mismatch")).toBeDefined();
  });

  test("stays on the unsupported notice when the assistant is too old", async () => {
    supportsDebugDatabase = false;
    const { findByText, queryByText } = renderPanel();
    expect(
      await findByText(
        "This assistant version does not report database diagnostics yet.",
      ),
    ).toBeDefined();
    await waitFor(() => {
      expect(queryByText("Ready")).toBeNull();
    });
  });

  test("treats a 404 as unsupported for released assistants without the route", async () => {
    databaseError = new ApiError(404, "Not Found");
    const { findByText } = renderPanel();
    expect(
      await findByText(
        "This assistant version does not report database diagnostics yet.",
      ),
    ).toBeDefined();
  });
});
