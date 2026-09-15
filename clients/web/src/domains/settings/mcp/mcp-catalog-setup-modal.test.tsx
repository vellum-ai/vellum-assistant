import { afterEach, expect, mock, test } from "bun:test";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { ApiError } from "@/utils/api-errors";
import { mcpCatalogEntry } from "../integration-test-fixtures";

const post = mock(async () => {
  throw new ApiError(422, "Private backend detail", {
    code: "PUBLIC_INGRESS_NOT_CONFIGURED",
  });
});
mock.module("@/generated/daemon/client.gen", () => ({ client: { post } }));
mock.module("@/lib/sentry/capture-error", () => ({ captureError: () => {} }));
const { McpCatalogSetupModal } = await import("./mcp-catalog-setup-modal");
afterEach(cleanup);

test("manual setup explains the missing callback and keeps Connect disabled", async () => {
  const client = new QueryClient({
    defaultOptions: { mutations: { retry: false } },
  });
  const connect = mock(() => {});
  render(
    <QueryClientProvider client={client}>
      <McpCatalogSetupModal
        assistantId="assistant-1"
        entry={mcpCatalogEntry({ setup: { mode: "manual" } })}
        onClose={() => {}}
        onConnect={connect}
      />
    </QueryClientProvider>,
  );
  fireEvent.click(screen.getByRole("button", { name: "Get callback URL" }));
  await waitFor(() =>
    expect(screen.getByRole("alert").textContent).toContain(
      "needs a callback address",
    ),
  );
  expect(screen.queryByText("Private backend detail")).toBeNull();
  expect(
    (screen.getByRole("button", { name: "Connect" }) as HTMLButtonElement)
      .disabled,
  ).toBe(true);
  expect(connect).not.toHaveBeenCalled();
  client.clear();
});
