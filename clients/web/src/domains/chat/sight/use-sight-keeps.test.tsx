/**
 * The composer's ambient keep stream: what opens it, what one keep costs on the
 * wire, the order keeps reach the daemon in, and who owns an uploaded row when
 * something goes wrong.
 *
 * The sampler, the frame encoder, the resize, the upload and the persist are
 * all replaced. None of them can do its real work here (happy-dom has no video
 * decode, no canvas readback and no daemon), and each is covered by its own
 * suite, so what is under test is the wiring between them.
 *
 * The camera store is real, since the stream's whole subject is the frames that
 * store holds and gives up.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { act, cleanup, renderHook } from "@testing-library/react";

import type { UploadAttachmentResult } from "@/domains/chat/api/messages";
import { fakeCameraStream } from "@/domains/chat/sight/sight.test-helper";
import {
  restoreMediaDevices,
  stubMediaDevices,
} from "@/domains/chat/voice/voice-room/voice-camera.test-helper";
import type { FrameSamplerOptions } from "@/lib/camera/frame-sampler";

/** What each wire step did, in the order it happened. */
let wireLog: string[] = [];

let samplerOptions: FrameSamplerOptions | null = null;
mock.module("@/lib/camera/frame-sampler", () => ({
  createFrameSampler: (options: FrameSamplerOptions) => {
    samplerOptions = options;
    return { start: () => {}, stop: () => {} };
  },
}));

const captureVideoFrame = mock(
  async (_video: HTMLVideoElement, filename: string) =>
    new File([new Uint8Array([1, 2, 3])], filename, { type: "image/jpeg" }),
);
mock.module("@/domains/chat/voice/voice-room/voice-camera", () => ({
  captureVideoFrame,
}));

mock.module(
  "@/domains/chat/components/chat-attachments/attachment-image-resize",
  () => ({
    prepareImageAttachmentForUpload: async (file: File) => ({
      status: "unchanged" as const,
      file,
    }),
  }),
);

/** Uploads in flight, so a test can hold one open across a scope change. */
let pendingUploads: Array<(result: UploadAttachmentResult) => void> = [];
let uploadsResolveImmediately = true;
let uploadCount = 0;
const uploadChatAttachment = mock(
  (_assistantId: string, _file: File): Promise<UploadAttachmentResult> => {
    uploadCount += 1;
    const id = `att-${uploadCount}`;
    wireLog.push(`upload ${id}`);
    if (uploadsResolveImmediately) {
      return Promise.resolve({ ok: true, id });
    }
    return new Promise((resolve) => {
      pendingUploads.push(resolve);
    });
  },
);
const deleteChatAttachment = mock(
  async (_assistantId: string, attachmentId: string) => {
    wireLog.push(`delete ${attachmentId}`);
    return true;
  },
);
mock.module("@/domains/chat/api/messages", () => ({
  uploadChatAttachment,
  deleteChatAttachment,
}));

/** How the daemon answers the next persist. */
interface PersistOutcome {
  readonly status: number;
  readonly persisted?: boolean;
  /** A failure with no response at all: the request never completed. */
  readonly transportFailure?: boolean;
}

interface PersistRequest {
  readonly path: { assistant_id: string; id: string };
  readonly body: { attachmentId: string };
  readonly throwOnError?: boolean;
}

interface PersistResult {
  data?: { persisted: boolean; messageId?: string };
  response?: { ok: boolean; status: number };
}

let nextOutcome: PersistOutcome = { status: 200, persisted: true };
/** Persists in flight, so a test can keep one open while newer keeps arrive. */
let pendingPersists: Array<(result: PersistResult) => void> = [];
let persistsResolveImmediately = true;
const persistRequests: PersistRequest[] = [];

function outcomeToResult(outcome: PersistOutcome): PersistResult {
  if (outcome.status !== 200) {
    return { response: { ok: false, status: outcome.status } };
  }
  return {
    data: {
      persisted: outcome.persisted === true,
      ...(outcome.persisted === true ? { messageId: "msg-1" } : {}),
    },
    response: { ok: true, status: 200 },
  };
}

const conversationsByIdSightframePost = mock(
  (request: PersistRequest): Promise<PersistResult> => {
    persistRequests.push(request);
    wireLog.push(`persist ${request.body.attachmentId}`);
    const outcome = nextOutcome;
    if (outcome.transportFailure) {
      return Promise.reject(new Error("network down"));
    }
    if (persistsResolveImmediately) {
      return Promise.resolve(outcomeToResult(outcome));
    }
    return new Promise((resolve) => {
      pendingPersists.push(resolve);
    });
  },
);
const realSdk = await import("@/generated/daemon/sdk.gen");
mock.module("@/generated/daemon/sdk.gen", () => ({
  ...realSdk,
  conversationsByIdSightframePost,
}));

const { useSightKeeps } = await import("./use-sight-keeps");
const { useSightStore } = await import("./sight-store");
const { useAssistantIdentityStore } =
  await import("@/stores/assistant-identity-store");
const { useClientFeatureFlagStore } =
  await import("@/stores/client-feature-flag-store");
const { useConversationStore } = await import("@/stores/conversation-store");
const { useResolvedAssistantsStore } =
  await import("@/stores/resolved-assistants-store");

const ASSISTANT_ID = "asst_sight";
const OTHER_ASSISTANT_ID = "asst_other";
const CONVERSATION_ID = "conv_sight";
const OTHER_CONVERSATION_ID = "conv_other";
/** Above the gate's floor, whatever that floor is pinned to. */
const SUPPORTING_VERSION = "99.99.99";

const KEEP = {
  keep: true as const,
  reason: "novel" as const,
  motion: null,
  novelty: 0.9,
  detail: 40,
};

/**
 * Let the store's encode, React's commit, and the persist chain's awaits all
 * run. Three passes rather than one: the keep lands a render behind the encode,
 * and the chain behind that.
 */
async function flush(): Promise<void> {
  for (let pass = 0; pass < 3; pass += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

/** Open the camera the way the toggle does and start sampling. */
async function startCamera(): Promise<void> {
  const camera = fakeCameraStream();
  stubMediaDevices(() => Promise.resolve(camera.stream));
  await act(async () => {
    await useSightStore.getState().start();
  });
  act(() => {
    useSightStore
      .getState()
      .attachPreviewVideo(document.createElement("video"));
  });
}

/** Offer one kept frame to the running sampler and settle what follows. */
async function keepFrame(): Promise<void> {
  act(() => {
    samplerOptions?.onDecision(KEEP, performance.now());
  });
  await flush();
}

beforeEach(() => {
  wireLog = [];
  samplerOptions = null;
  uploadCount = 0;
  pendingUploads = [];
  uploadsResolveImmediately = true;
  pendingPersists = [];
  persistsResolveImmediately = true;
  persistRequests.length = 0;
  nextOutcome = { status: 200, persisted: true };
  captureVideoFrame.mockClear();
  uploadChatAttachment.mockClear();
  deleteChatAttachment.mockClear();
  conversationsByIdSightframePost.mockClear();
  useResolvedAssistantsStore.getState().setActiveAssistantId(ASSISTANT_ID);
  useConversationStore.getState().setActiveConversationId(CONVERSATION_ID);
  useAssistantIdentityStore
    .getState()
    .setIdentity("assistant", SUPPORTING_VERSION, ASSISTANT_ID);
  useClientFeatureFlagStore
    .getState()
    .setStringFlags({ visionMode: "on" }, null);
});

afterEach(() => {
  cleanup();
  useSightStore.getState().stop();
  useAssistantIdentityStore.getState().clearIdentity();
  useConversationStore.getState().setActiveConversationId(null);
  restoreMediaDevices();
});

describe("useSightKeeps: what opens the stream", () => {
  test("persists the frames the gate keeps", async () => {
    renderHook(() => useSightKeeps());
    await startCamera();

    await keepFrame();

    expect(wireLog).toEqual(["upload att-1", "persist att-1"]);
    expect(persistRequests[0]?.path).toEqual({
      assistant_id: ASSISTANT_ID,
      id: CONVERSATION_ID,
    });
    expect(persistRequests[0]?.body).toEqual({ attachmentId: "att-1" });
  });

  test("nothing moves while the camera is off", async () => {
    renderHook(() => useSightKeeps());

    // No camera is no consent, and there is nothing to sample in any case.
    act(() => {
      samplerOptions?.onDecision(KEEP, performance.now());
    });
    await flush();

    expect(wireLog).toEqual([]);
  });

  test("nothing moves while the vision-mode flag is off", async () => {
    useClientFeatureFlagStore
      .getState()
      .setStringFlags({ visionMode: "off" }, null);
    renderHook(() => useSightKeeps());
    await startCamera();

    await keepFrame();

    expect(wireLog).toEqual([]);
  });

  test("nothing moves while the version gate is closed", async () => {
    // The identity store holds a version fetched for somebody else, which the
    // scoped gate refuses. Which VERSIONS the gate admits is pinned in its own
    // suite; what matters here is that a closed gate uploads nothing.
    useAssistantIdentityStore
      .getState()
      .setIdentity("assistant", SUPPORTING_VERSION, OTHER_ASSISTANT_ID);
    renderHook(() => useSightKeeps());
    await startCamera();

    await keepFrame();

    expect(wireLog).toEqual([]);
  });

  test("nothing moves before a version has hydrated", async () => {
    useAssistantIdentityStore.getState().clearIdentity();
    renderHook(() => useSightKeeps());
    await startCamera();

    await keepFrame();

    expect(wireLog).toEqual([]);
  });

  test("nothing moves with no conversation open", async () => {
    // A keep with nowhere to land: the route writes into a conversation by id.
    useConversationStore.getState().setActiveConversationId(null);
    renderHook(() => useSightKeeps());
    await startCamera();

    await keepFrame();

    expect(wireLog).toEqual([]);
  });

  test("nothing moves once the user has left the conversation", async () => {
    renderHook(() => useSightKeeps());
    await startCamera();

    act(() => {
      useConversationStore
        .getState()
        .setActiveConversationId(OTHER_CONVERSATION_ID);
      useResolvedAssistantsStore
        .getState()
        .setActiveAssistantId(OTHER_ASSISTANT_ID);
    });
    await keepFrame();

    // The gate is scoped to the assistant the identity was fetched for, so a
    // switch closes the stream rather than pointing it at the new one.
    expect(wireLog).toEqual([]);
  });
});

describe("useSightKeeps: one keep at a time", () => {
  test("uploads and persists each keep exactly once, in capture order", async () => {
    renderHook(() => useSightKeeps());
    await startCamera();

    await keepFrame();
    await keepFrame();

    expect(wireLog).toEqual([
      "upload att-1",
      "persist att-1",
      "upload att-2",
      "persist att-2",
    ]);
  });

  test("a keep made while the one before it is in flight waits its turn", async () => {
    // Adjacency is the whole correlation between a frame and the words around
    // it, so a scene persisted after a newer one reads as the view the words
    // that follow were about.
    persistsResolveImmediately = false;
    renderHook(() => useSightKeeps());
    await startCamera();

    await keepFrame();
    await keepFrame();

    // The second keep has not touched the wire: the first persist is still open.
    expect(wireLog).toEqual(["upload att-1", "persist att-1"]);

    act(() => {
      pendingPersists.shift()?.(
        outcomeToResult({ status: 200, persisted: true }),
      );
    });
    await flush();

    expect(wireLog).toEqual([
      "upload att-1",
      "persist att-1",
      "upload att-2",
      "persist att-2",
    ]);
  });

  test("a persisted keep is not attached to the next send as well", async () => {
    renderHook(() => useSightKeeps());
    await startCamera();

    await keepFrame();
    expect(useSightStore.getState().latestKeep).toBeNull();

    // With the held keep consumed, the send falls through to a live capture:
    // the current view rather than a second copy of the frame already sitting
    // in the transcript.
    captureVideoFrame.mockClear();
    const sendFrame = await useSightStore.getState().takeSendFrame();

    expect(sendFrame).not.toBeNull();
    expect(captureVideoFrame).toHaveBeenCalledTimes(1);
  });

  test("a keep made during the persist survives it", async () => {
    // The consume is keyed on the file, so a frame the camera made while the
    // older one was being written is left for the next send.
    persistsResolveImmediately = false;
    renderHook(() => useSightKeeps());
    await startCamera();

    await keepFrame();
    await keepFrame();
    const newer = useSightStore.getState().latestKeep;
    expect(newer).not.toBeNull();

    act(() => {
      pendingPersists.shift()?.(
        outcomeToResult({ status: 200, persisted: true }),
      );
    });
    await flush();

    expect(useSightStore.getState().latestKeep).toBe(newer);
  });
});

describe("useSightKeeps: who owns the upload", () => {
  test("a dropped frame is left to the daemon", async () => {
    // A 200 saying `persisted: false` means the daemon took the frame and
    // released the upload on its way out. Deleting here would race a row this
    // no longer owns.
    nextOutcome = { status: 200, persisted: false };
    renderHook(() => useSightKeeps());
    await startCamera();

    await keepFrame();

    expect(wireLog).toEqual(["upload att-1", "persist att-1"]);
    expect(deleteChatAttachment).not.toHaveBeenCalled();
    // Nothing was written, so the frame is still the one a send would carry.
    expect(useSightStore.getState().latestKeep).not.toBeNull();
  });

  test("a refused persist gives the upload back", async () => {
    // A 404 is answered before the persist runs, so the row is still this
    // caller's and nothing else will ever collect it.
    nextOutcome = { status: 404 };
    renderHook(() => useSightKeeps());
    await startCamera();

    await keepFrame();

    expect(wireLog).toEqual(["upload att-1", "persist att-1", "delete att-1"]);
  });

  test("a persist that never completed gives the upload back", async () => {
    nextOutcome = { status: 200, transportFailure: true };
    renderHook(() => useSightKeeps());
    await startCamera();

    await keepFrame();

    expect(wireLog).toEqual(["upload att-1", "persist att-1", "delete att-1"]);
  });

  test("a refused upload leaves nothing behind", async () => {
    uploadChatAttachment.mockImplementationOnce(() => {
      wireLog.push("upload refused");
      return Promise.resolve({
        ok: false,
        status: 413,
        error: { detail: "too large" },
      });
    });
    renderHook(() => useSightKeeps());
    await startCamera();

    await keepFrame();

    expect(wireLog).toEqual(["upload refused"]);
    expect(conversationsByIdSightframePost).not.toHaveBeenCalled();
    expect(deleteChatAttachment).not.toHaveBeenCalled();
  });

  test("a conversation left during the upload gets no frame", async () => {
    uploadsResolveImmediately = false;
    renderHook(() => useSightKeeps());
    await startCamera();

    await keepFrame();
    expect(wireLog).toEqual(["upload att-1"]);

    act(() => {
      useConversationStore
        .getState()
        .setActiveConversationId(OTHER_CONVERSATION_ID);
    });
    act(() => {
      pendingUploads.shift()?.({ ok: true, id: "att-1" });
    });
    await flush();

    // Persisting now would put a view taken in one conversation into another
    // that never saw it, so the row goes back instead.
    expect(wireLog).toEqual(["upload att-1", "delete att-1"]);
    expect(conversationsByIdSightframePost).not.toHaveBeenCalled();
  });

  test("a camera closed during the upload gets no frame", async () => {
    uploadsResolveImmediately = false;
    renderHook(() => useSightKeeps());
    await startCamera();

    await keepFrame();
    expect(wireLog).toEqual(["upload att-1"]);

    act(() => {
      useSightStore.getState().stop();
    });
    act(() => {
      pendingUploads.shift()?.({ ok: true, id: "att-1" });
    });
    await flush();

    expect(wireLog).toEqual(["upload att-1", "delete att-1"]);
    expect(conversationsByIdSightframePost).not.toHaveBeenCalled();
  });

  test("a surface that unmounts during the upload gets no frame", async () => {
    uploadsResolveImmediately = false;
    const view = renderHook(() => useSightKeeps());
    await startCamera();

    await keepFrame();
    expect(wireLog).toEqual(["upload att-1"]);

    view.unmount();
    act(() => {
      pendingUploads.shift()?.({ ok: true, id: "att-1" });
    });
    await flush();

    expect(wireLog).toEqual(["upload att-1", "delete att-1"]);
    expect(conversationsByIdSightframePost).not.toHaveBeenCalled();
  });
});
