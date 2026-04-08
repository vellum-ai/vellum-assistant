import { afterEach, describe, expect, mock, test } from "bun:test";

import type { AssistantConfig } from "../config/types.js";
import {
  clearEmbeddingBackendCache,
  resetLocalEmbeddingFailureState,
  selectEmbeddingBackend,
} from "./embedding-backend.js";

const LOCAL_CONFIG = {
  memory: {
    embeddings: {
      provider: "local",
      localModel: "BAAI/bge-small-en-v1.5",
    },
  },
} as unknown as AssistantConfig;

describe("embedding backend cache invalidation", () => {
  afterEach(() => {
    clearEmbeddingBackendCache();
  });

  test("clearEmbeddingBackendCache disposes cached backends before clearing", async () => {
    const firstSelection = await selectEmbeddingBackend(LOCAL_CONFIG);
    expect(firstSelection.backend).not.toBeNull();

    const dispose = mock();
    (firstSelection.backend as { dispose?: () => void }).dispose = dispose;

    clearEmbeddingBackendCache();

    expect(dispose).toHaveBeenCalledTimes(1);

    const secondSelection = await selectEmbeddingBackend(LOCAL_CONFIG);
    expect(secondSelection.backend).not.toBe(firstSelection.backend);
  });

  test("resetLocalEmbeddingFailureState preserves live cached backends", async () => {
    const firstSelection = await selectEmbeddingBackend(LOCAL_CONFIG);
    expect(firstSelection.backend).not.toBeNull();

    const dispose = mock();
    (firstSelection.backend as { dispose?: () => void }).dispose = dispose;

    resetLocalEmbeddingFailureState();

    expect(dispose).not.toHaveBeenCalled();

    const secondSelection = await selectEmbeddingBackend(LOCAL_CONFIG);
    expect(secondSelection.backend).toBe(firstSelection.backend);
  });
});
