/**
 * The avatar routes hand the store who made a change and from which OS, and
 * the store records the `avatar_changed` event. The fan-out and outbox
 * modules are mocked so the origin id and the event payload can be asserted
 * against the request headers that produced them.
 */
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

/** The origin id handed to the fan-out, one entry per announced change. */
const publishedOrigins: Array<string | undefined> = [];
mock.module("../../sync/resource-sync-events.js", () => ({
  getOriginClientId: (headers: Record<string, string> | undefined) =>
    headers?.["x-vellum-client-id"]?.trim() || undefined,
  publishAvatarChanged: (originClientId?: string) => {
    publishedOrigins.push(originClientId);
  },
}));

/** Every telemetry event the store records, in order. */
const recorded: Array<{ name: string; fields: Record<string, unknown> }> = [];
mock.module("../../../telemetry/telemetry-events-outbox.js", () => ({
  recordTelemetryEvent: (name: string, fields: Record<string, unknown>) => {
    recorded.push({ name, fields });
    return { id: "evt", createdAt: 0 };
  },
}));

import { ROUTES } from "../avatar-routes.js";
import type { RouteHandlerArgs } from "../types.js";

/** A 4x4 PNG of one red (#c81e1e), so an accent can be read out of it. */
const RED_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAQAAAAECAYAAACp8Z5+AAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAEklEQVQImWM4ISf3HxkzkC4AAEG4IDHG8wOiAAAAAElFTkSuQmCC";

/** Resolve a handler from the route registry by operationId. */
function getHandler(operationId: string) {
  const route = ROUTES.find((r) => r.operationId === operationId);
  if (!route) {
    throw new Error(`${operationId} route not registered`);
  }
  return route.handler as (
    args: RouteHandlerArgs,
  ) => unknown | Promise<unknown>;
}

describe("avatar routes pass the caller to the store", () => {
  let workspaceDir: string;
  let prevWorkspaceDir: string | undefined;

  beforeEach(() => {
    workspaceDir = mkdtempSync(join(tmpdir(), "avatar-routes-telemetry-"));
    mkdirSync(join(workspaceDir, "data", "avatar"), { recursive: true });
    prevWorkspaceDir = process.env.VELLUM_WORKSPACE_DIR;
    process.env.VELLUM_WORKSPACE_DIR = workspaceDir;
    publishedOrigins.length = 0;
    recorded.length = 0;
  });

  afterEach(() => {
    if (prevWorkspaceDir === undefined) {
      delete process.env.VELLUM_WORKSPACE_DIR;
    } else {
      process.env.VELLUM_WORKSPACE_DIR = prevWorkspaceDir;
    }
    rmSync(workspaceDir, { recursive: true, force: true });
  });

  const upload = (headers?: Record<string, string>) =>
    getHandler("avatar_upload_image")({
      body: { content: RED_PNG_BASE64 },
      headers,
    });

  test("the client-os header reaches the event, sanitized", async () => {
    await upload({ "x-vellum-client-os": " macOS " });

    expect(recorded).toHaveLength(1);
    expect(recorded[0]!.name).toBe("avatar_changed");
    expect(recorded[0]!.fields).toMatchObject({
      action: "upload_image",
      client_os: "macos",
    });
  });

  test("an out-of-bounds client-os header is dropped, not forwarded", async () => {
    await upload({ "x-vellum-client-os": "a".repeat(65) });

    expect(recorded).toHaveLength(1);
    expect(recorded[0]!.fields).not.toHaveProperty("client_os");
  });

  test("no headers yields an event without client_os", async () => {
    await upload();

    expect(recorded).toHaveLength(1);
    expect(recorded[0]!.fields).not.toHaveProperty("client_os");
  });

  test("the client id still reaches the fan-out", async () => {
    await upload({ "x-vellum-client-id": "web-1" });

    expect(publishedOrigins).toEqual(["web-1"]);
  });
});
