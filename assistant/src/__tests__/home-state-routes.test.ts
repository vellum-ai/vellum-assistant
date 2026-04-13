import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

// Stub the OAuth connection store before importing anything that
// transitively pulls in the writer — otherwise importing the route
// module would try to open the real OAuth DB.
mock.module("../oauth/oauth-store.js", () => ({
  listConnections: () => [],
}));

// Stub the DB-authoritative conversation count helper so the writer
// (invoked by the read-through fallback) does not lazy-open a real
// sqlite handle against a stale or deleted per-test tmpdir.
mock.module("../memory/conversation-queries.js", () => ({
  countConversations: () => 0,
}));

const { handleGetHomeState, homeStateRouteDefinitions } =
  await import("../runtime/routes/home-state-routes.js");
const { writeRelationshipState, getRelationshipStatePath } =
  await import("../home/relationship-state-writer.js");

interface RelationshipStateWire {
  version: number;
  assistantId: string;
  tier: number;
  progressPercent: number;
  facts: unknown[];
  capabilities: Array<{ id: string; tier: string }>;
  conversationCount: number;
  hatchedDate: string;
  assistantName: string;
  userName?: string;
  updatedAt: string;
}

let workspaceDir: string;
let origWorkspaceDir: string | undefined;

beforeEach(() => {
  workspaceDir = mkdtempSync(join(tmpdir(), "vellum-hsr-"));
  origWorkspaceDir = process.env.VELLUM_WORKSPACE_DIR;
  process.env.VELLUM_WORKSPACE_DIR = workspaceDir;
});

afterEach(() => {
  if (origWorkspaceDir === undefined) {
    delete process.env.VELLUM_WORKSPACE_DIR;
  } else {
    process.env.VELLUM_WORKSPACE_DIR = origWorkspaceDir;
  }
  try {
    rmSync(workspaceDir, { recursive: true, force: true });
  } catch {
    // best-effort cleanup
  }
});

describe("home-state-routes", () => {
  describe("route registration", () => {
    test("exposes GET /v1/home/state", () => {
      const routes = homeStateRouteDefinitions();
      expect(routes).toHaveLength(1);
      expect(routes[0].endpoint).toBe("home/state");
      expect(routes[0].method).toBe("GET");
    });
  });

  describe("handleGetHomeState", () => {
    test("returns persisted state when the JSON file exists", async () => {
      // Seed a minimal USER.md so the writer produces a non-empty
      // state, then let the writer persist it.
      mkdirSync(workspaceDir, { recursive: true });
      writeFileSync(
        join(workspaceDir, "USER.md"),
        "- Preferred name: Casey\n- Work role: Engineer\n",
        "utf-8",
      );
      await writeRelationshipState();
      expect(existsSync(getRelationshipStatePath())).toBe(true);

      const res = await handleGetHomeState();
      expect(res.status).toBe(200);
      const body = (await res.json()) as RelationshipStateWire;
      expect(body.version).toBe(1);
      expect(body.assistantId).toBe("default");
      expect(body.capabilities).toHaveLength(6);
      expect(body.userName).toBe("Casey");
      expect(typeof body.updatedAt).toBe("string");
      expect(Number.isNaN(Date.parse(body.updatedAt))).toBe(false);
    });

    test("read-through fallback when the file is missing", async () => {
      // Do NOT call the writer — the file should not exist. The
      // route must still succeed via computeRelationshipState().
      expect(existsSync(getRelationshipStatePath())).toBe(false);

      const res = await handleGetHomeState();
      expect(res.status).toBe(200);
      const body = (await res.json()) as RelationshipStateWire;
      expect(body.version).toBe(1);
      expect(body.tier).toBe(1);
      expect(body.progressPercent).toBe(0);
      expect(body.capabilities).toHaveLength(6);
      expect(body.conversationCount).toBe(0);

      // Fallback must NOT write the file — that's the writer's job.
      expect(existsSync(getRelationshipStatePath())).toBe(false);
    });

    test("falls back to compute when the persisted file is malformed", async () => {
      // Write a deliberately broken file at the state path.
      const path = getRelationshipStatePath();
      mkdirSync(join(path, ".."), { recursive: true });
      writeFileSync(path, "this is not json", "utf-8");

      const res = await handleGetHomeState();
      expect(res.status).toBe(200);
      const body = (await res.json()) as RelationshipStateWire;
      // Parsed body is a fresh compute, not the garbage on disk.
      expect(body.version).toBe(1);
      expect(body.capabilities).toHaveLength(6);
    });
  });
});
