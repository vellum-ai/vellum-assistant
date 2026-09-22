/**
 * Process teardown reaches every local embedding worker the process owns.
 *
 * Kept in its own file: `shutdownEmbeddingBackends` latches the module into its
 * shut-down state for the rest of the process.
 */
import { expect, test } from "bun:test";

import { AssistantConfigSchema } from "../../config/schema.js";
import {
  clearEmbeddingBackendCache,
  selectEmbeddingBackend,
  shutdownEmbeddingBackends,
} from "./embedding-backend.js";

/** Reach past `private`, which is compile-time only, so tests drive real state. */
type Internals = any;

/**
 * A backend-cache reset forgets a backend whose disposal is waiting on
 * in-flight embeds, while that backend still holds a live worker.
 */
test("shutdown reaps a busy local worker the cache has already forgotten", async () => {
  const config = AssistantConfigSchema.parse({
    memory: { embeddings: { provider: "local" } },
  });
  const { backend } = await selectEmbeddingBackend(config);
  const delegate = await (backend as Internals).getDelegate();
  let killed = false;
  delegate.workerProc = {
    pid: 7201,
    exited: new Promise<number>(() => {}),
    kill() {
      killed = true;
    },
    stdin: { write: () => 0, flush: () => 0 },
  };
  delegate.terminateGraceMs = 10;
  delegate.activeEmbeds = 1;

  clearEmbeddingBackendCache();
  expect(killed).toBe(false);

  await shutdownEmbeddingBackends();

  expect(killed).toBe(true);
});
