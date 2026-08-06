/**
 * The daemon-side handler for the worker → daemon documents-changed hand-off.
 * A sidecar worker's own hub has no SSE subscriber, so it asks the daemon to
 * republish the invalidation where clients actually observe it.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";

const publishCalls: Array<string | undefined> = [];

mock.module("../../../runtime/sync/resource-sync-events.js", () => ({
  publishDocumentsChanged: (originClientId?: string) => {
    publishCalls.push(originClientId);
  },
}));

import { DB_MIGRATION_READINESS_EXEMPT_OPERATIONS } from "../../../daemon/daemon-readiness.js";
import { NOTIFY_DOCUMENTS_CHANGED_IPC_METHOD } from "../../../runtime/sync/worker-daemon-notify.js";
import {
  DOCUMENTS_SYNC_IPC_METHODS,
  handleNotifyDocumentsChanged,
} from "../documents-sync-ipc-routes.js";

describe("documents-sync IPC route", () => {
  beforeEach(() => {
    publishCalls.length = 0;
  });

  test("republishes the documents-changed invalidation on the daemon", () => {
    const result = handleNotifyDocumentsChanged({ body: {} });

    expect(result).toEqual({ ok: true });
    expect(publishCalls).toEqual([undefined]);
  });

  test("carries no origin client id, so no client suppresses it", () => {
    // The hand-off comes from a background turn with no originating client.
    handleNotifyDocumentsChanged({ body: {} });

    expect(publishCalls[0]).toBeUndefined();
  });

  test("is reachable on the IPC surface under the shared method name", () => {
    expect(
      typeof DOCUMENTS_SYNC_IPC_METHODS[NOTIFY_DOCUMENTS_CHANGED_IPC_METHOD],
    ).toBe("function");
  });

  test("is DB-migration readiness gated (absent from the exempt set)", () => {
    expect(
      DB_MIGRATION_READINESS_EXEMPT_OPERATIONS.has(
        NOTIFY_DOCUMENTS_CHANGED_IPC_METHOD,
      ),
    ).toBe(false);
  });
});
