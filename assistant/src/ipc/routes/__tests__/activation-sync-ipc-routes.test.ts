/**
 * The daemon-side handler for the worker → daemon activation-progress
 * hand-off. A sidecar worker's own hub has no SSE subscriber, so it asks the
 * daemon to republish the invalidation where clients actually observe it.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";

const publishCalls: Array<string | undefined> = [];

mock.module("../../../runtime/sync/resource-sync-events.js", () => ({
  publishActivationProgressChanged: (originClientId?: string) => {
    publishCalls.push(originClientId);
  },
}));

import { DB_MIGRATION_READINESS_EXEMPT_OPERATIONS } from "../../../daemon/daemon-readiness.js";
import { NOTIFY_ACTIVATION_PROGRESS_CHANGED_IPC_METHOD } from "../../../runtime/sync/worker-daemon-notify.js";
import {
  ACTIVATION_SYNC_IPC_METHODS,
  handleNotifyActivationProgressChanged,
} from "../activation-sync-ipc-routes.js";

describe("activation-sync IPC route", () => {
  beforeEach(() => {
    publishCalls.length = 0;
  });

  test("republishes the activation-progress invalidation on the daemon", () => {
    const result = handleNotifyActivationProgressChanged({ body: {} });

    expect(result).toEqual({ ok: true });
    expect(publishCalls).toEqual([undefined]);
  });

  test("is reachable on the IPC surface under the shared method name", () => {
    expect(
      typeof ACTIVATION_SYNC_IPC_METHODS[
        NOTIFY_ACTIVATION_PROGRESS_CHANGED_IPC_METHOD
      ],
    ).toBe("function");
  });

  test("is DB-migration readiness gated (absent from the exempt set)", () => {
    expect(
      DB_MIGRATION_READINESS_EXEMPT_OPERATIONS.has(
        NOTIFY_ACTIVATION_PROGRESS_CHANGED_IPC_METHOD,
      ),
    ).toBe(false);
  });
});
