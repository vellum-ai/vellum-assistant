/**
 * Backend-agnostic memory-graph topology route.
 *
 * `GET /memory-graph` returns the assistant's memory as a canonical
 * {@link MemoryGraph} (nodes + edges), independent of which memory backend is
 * active. Today it is served from memory-v3; when memory is fully pluginified
 * the handler resolves the active backend instead — the endpoint, its shape,
 * and every client that consumes it stay put. Backends without a graph return
 * `{ supported: false }` (HTTP 200), which clients render as a dedicated empty
 * state rather than an error.
 */

import { getConfig } from "../../../../config/loader.js";
import {
  ACTOR_PRINCIPALS,
  type RoutePolicy,
} from "../../../../runtime/auth/route-policy.js";
import type { RouteDefinition } from "../../../../runtime/routes/types.js";
import {
  getMemoryGraph,
  getMemoryGraphNode,
} from "../graph-topology/build-memory-graph.js";
import {
  MemoryGraphNodeDetailSchema,
  MemoryGraphSchema,
} from "../graph-topology/types.js";

const READ_POLICY: RoutePolicy = {
  requiredScopes: ["settings.read"],
  allowedPrincipalTypes: ACTOR_PRINCIPALS,
};

export const ROUTES: RouteDefinition[] = [
  {
    operationId: "getMemoryGraph",
    endpoint: "memory-graph",
    method: "GET",
    policy: READ_POLICY,
    summary: "Get the memory graph",
    description:
      "Return the assistant's memory as a backend-agnostic graph of nodes " +
      "(concepts, skills, capabilities) and edges (authored links and learned " +
      "associations). Returns supported=false when the active backend exposes " +
      "no graph.",
    tags: ["memory"],
    responseBody: MemoryGraphSchema,
    handler: () => getMemoryGraph(getConfig()),
  },
  {
    operationId: "getMemoryGraphNode",
    endpoint: "memory-graph-node",
    method: "GET",
    policy: READ_POLICY,
    summary: "Get a memory graph node's content",
    description:
      "Return the rendered markdown content of a single concept node by id, " +
      "for the graph's node-detail view. `found: false` when the node has no " +
      "readable page.",
    tags: ["memory"],
    queryParams: [
      {
        name: "id",
        schema: { type: "string" },
        description: "Node id (concept-page slug).",
      },
    ],
    responseBody: MemoryGraphNodeDetailSchema,
    handler: ({ queryParams }) =>
      getMemoryGraphNode(getConfig(), queryParams?.id ?? ""),
  },
];
