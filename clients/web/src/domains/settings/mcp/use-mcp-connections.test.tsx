import { afterEach, expect, mock, test } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { createElement, type ReactNode } from "react";

import type { McpServerEntry, McpToolsSummaryServer } from "./mcp-api";
import { mcpQueryKeys } from "./mcp-query-keys";

const servers: McpServerEntry[] = [
  {
    id: "server-one",
    status: "connected",
    transport: { type: "streamable-http", url: "https://one.example.com/mcp" },
    hasOAuth: false,
    hasStaticAuth: false,
    authType: "none",
  },
  {
    id: "server-two",
    status: "connected",
    transport: { type: "streamable-http", url: "https://two.example.com/mcp" },
    hasOAuth: false,
    hasStaticAuth: false,
    authType: "none",
  },
];
const cachedSummaries: McpToolsSummaryServer[] = servers.map((server) => ({
  serverId: server.id,
  toolCount: 1,
  estimatedTokens: 20,
  tools: [
    {
      name: `${server.id}-tool`,
      description: "Example tool",
      estimatedTokens: 20,
    },
  ],
}));

let resolveDetails!: (value: {
  servers: McpToolsSummaryServer[];
  totalToolCount: number;
  totalEstimatedTokens: number;
}) => void;

mock.module("./mcp-api", () => ({
  fetchMcpServers: async () => ({ servers }),
  fetchMcpToolsSummary: () =>
    new Promise((resolve) => {
      resolveDetails = resolve;
    }),
  addMcpServer: async () => {},
  updateMcpServer: async () => {},
  removeMcpServer: async () => {},
  startMcpAuth: async () => ({ auth_url: "https://example.com/auth", state: "state" }),
  pollMcpAuthStatus: async () => ({ status: "pending" }),
}));

const { useMcpConnections } = await import("./use-mcp-connections");

afterEach(() => {
  cleanup();
});

test("keeps cached details while refreshing and switching configured servers", async () => {
  const client = new QueryClient({
    defaultOptions: {
      queries: { retry: false, refetchOnWindowFocus: false },
    },
  });
  client.setQueryData(mcpQueryKeys.list("assistant-123"), { servers });
  client.setQueryData(mcpQueryKeys.details("assistant-123"), {
    servers: cachedSummaries,
    totalToolCount: 2,
    totalEstimatedTokens: 40,
  });
  const wrapper = ({ children }: { children: ReactNode }) =>
    createElement(QueryClientProvider, { client }, children);
  const { result } = renderHook(() => useMcpConnections("assistant-123"), {
    wrapper,
  });

  act(() => result.current.setConfigureServerId("server-one"));
  await waitFor(() => expect(result.current.details.isFetching).toBe(true));
  expect(
    result.current.details.data?.servers.find(
      (entry) => entry.serverId === "server-one",
    )?.toolCount,
  ).toBe(1);

  act(() => result.current.setConfigureServerId("server-two"));
  expect(result.current.details.isFetching).toBe(true);
  expect(
    result.current.details.data?.servers.find(
      (entry) => entry.serverId === "server-two",
    )?.toolCount,
  ).toBe(1);

  resolveDetails({
    servers: cachedSummaries,
    totalToolCount: 2,
    totalEstimatedTokens: 40,
  });
  await waitFor(() => expect(result.current.details.isFetching).toBe(false));
  client.clear();
});
