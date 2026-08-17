import { afterEach, describe, expect, mock, test } from "bun:test";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const feedbackRequests: unknown[] = [];
let capacitorPlatform: "web" | "ios" | "android" = "web";
let rejectAndroidFeedbackClient = false;

mock.module("@/generated/api/@tanstack/react-query.gen", () => ({
  feedbackCreateMutation: () => ({
    mutationFn: async (request: unknown) => {
      feedbackRequests.push(request);
      if (
        rejectAndroidFeedbackClient &&
        (request as { body?: { client?: string } }).body?.client === "android"
      ) {
        throw { client: ["Unsupported client."] };
      }
      return { id: "feedback-1" };
    },
  }),
}));

mock.module("@capacitor/core", () => ({
  Capacitor: {
    getPlatform: () => capacitorPlatform,
    isNativePlatform: () => capacitorPlatform !== "web",
  },
  registerPlugin: () => ({}),
}));

mock.module("@/stores/auth-store", () => ({
  useAuthStore: {
    use: {
      user: () => null,
    },
  },
}));

const { ShareFeedbackModal, stripBulkBase64, dedupeAgainstClientMessages } =
  await import("@/components/share-feedback-modal");

afterEach(() => {
  cleanup();
  feedbackRequests.length = 0;
  capacitorPlatform = "web";
  rejectAndroidFeedbackClient = false;
  delete (window as unknown as { _vellumDebug?: unknown })._vellumDebug;
  delete (window as unknown as { vellum?: unknown }).vellum;
});

/** Decompress a logs_file and return the raw tar text. */
async function decompressLogs(logsFile: File): Promise<string> {
  return new Response(
    logsFile.stream().pipeThrough(new DecompressionStream("gzip")),
  ).text();
}

async function submitAndGetLogsText(): Promise<string> {
  const client = new QueryClient({
    defaultOptions: { mutations: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <ShareFeedbackModal
        open
        onClose={() => {}}
        initialReason="bug_report"
        initialMessage="Streaming froze."
      />
    </QueryClientProvider>,
  );
  const user = userEvent.setup();
  await user.type(screen.getByLabelText("Email"), "user@example.com");
  await user.click(screen.getByRole("button", { name: "Submit" }));
  await waitFor(() => expect(feedbackRequests).toHaveLength(1));
  const request = feedbackRequests[0] as { body: { logs_file?: File } };
  expect(request.body.logs_file).toBeInstanceOf(File);
  return decompressLogs(request.body.logs_file!);
}

describe("ShareFeedbackModal", () => {
  test("prefills the feedback message", () => {
    const client = new QueryClient({
      defaultOptions: { mutations: { retry: false } },
    });

    render(
      <QueryClientProvider client={client}>
        <ShareFeedbackModal
          open
          onClose={() => {}}
          initialReason="other"
          initialMessage="The app colors are ugly."
        />
      </QueryClientProvider>,
    );

    expect(
      (screen.getByLabelText("What's on your mind?") as HTMLTextAreaElement)
        .value,
    ).toBe("The app colors are ugly.");
  });

  test("reports Android shell feedback as android", async () => {
    capacitorPlatform = "android";
    const client = new QueryClient({
      defaultOptions: { mutations: { retry: false } },
    });

    render(
      <QueryClientProvider client={client}>
        <ShareFeedbackModal
          open
          onClose={() => {}}
          initialReason="other"
          initialMessage="The app colors are ugly."
        />
      </QueryClientProvider>,
    );

    const user = userEvent.setup();
    await user.type(screen.getByLabelText("Email"), "user@example.com");
    await user.click(screen.getByRole("button", { name: "Submit" }));

    await waitFor(() => expect(feedbackRequests).toHaveLength(1));
    const request = feedbackRequests[0] as { body: { client?: string } };
    expect(request.body.client).toBe("android");
  });

  test("falls back to web when the platform rejects Android", async () => {
    capacitorPlatform = "android";
    rejectAndroidFeedbackClient = true;
    const client = new QueryClient({
      defaultOptions: { mutations: { retry: false } },
    });

    render(
      <QueryClientProvider client={client}>
        <ShareFeedbackModal
          open
          onClose={() => {}}
          initialReason="other"
          initialMessage="The app colors are ugly."
        />
      </QueryClientProvider>,
    );

    const user = userEvent.setup();
    await user.type(screen.getByLabelText("Email"), "user@example.com");
    await user.click(screen.getByRole("button", { name: "Submit" }));

    await waitFor(() => expect(feedbackRequests).toHaveLength(2));
    expect(
      feedbackRequests.map(
        (request) => (request as { body: { client?: string } }).body.client,
      ),
    ).toEqual(["android", "web"]);
  });

  test("reports the desktop release version from the Electron host", async () => {
    (window as unknown as { vellum: unknown }).vellum = {
      platform: "electron",
      app: {
        versionInfo: async () => ({ version: "1.2.3" }),
      },
    };
    const client = new QueryClient({
      defaultOptions: { mutations: { retry: false } },
    });
    render(
      <QueryClientProvider client={client}>
        <ShareFeedbackModal
          open
          onClose={() => {}}
          initialReason="feature_request"
          initialMessage="Add a setting."
        />
      </QueryClientProvider>,
    );

    const user = userEvent.setup();
    await user.type(screen.getByLabelText("Email"), "user@example.com");
    await user.click(screen.getByRole("button", { name: "Submit" }));

    await waitFor(() => expect(feedbackRequests).toHaveLength(1));
    const request = feedbackRequests[0] as {
      body: { client?: string; client_version?: string };
    };
    expect(request.body).toMatchObject({
      client: "electron",
      client_version: "1.2.3",
    });
  });

  test("submits Doctor session id and transcript diagnostics", async () => {
    const client = new QueryClient({
      defaultOptions: { mutations: { retry: false } },
    });

    render(
      <QueryClientProvider client={client}>
        <ShareFeedbackModal
          open
          onClose={() => {}}
          initialReason="bug_report"
          initialMessage="The app colors are ugly."
          doctorSessionId="doctor-session-123"
          doctorSessionLog="User: I have feedback\n\nFeedback Prompt: The app colors are ugly."
        />
      </QueryClientProvider>,
    );

    const user = userEvent.setup();
    await user.type(screen.getByLabelText("Email"), "user@example.com");
    await user.click(screen.getByRole("button", { name: "Submit" }));

    await waitFor(() => expect(feedbackRequests).toHaveLength(1));
    const request = feedbackRequests[0] as {
      body: { doctor_session_id?: string; logs_file?: File };
    };
    expect(request.body.doctor_session_id).toBe("doctor-session-123");

    const logsFile = request.body.logs_file;
    expect(logsFile).toBeInstanceOf(File);
    const logsText = await new Response(
      logsFile!.stream().pipeThrough(new DecompressionStream("gzip")),
    ).text();
    expect(logsText).toContain("doctor-session.txt");
    expect(logsText).toContain("Feedback Prompt: The app colors are ugly.");
  });

  test("honors diagnostics opt-out for Doctor session transcripts", async () => {
    const client = new QueryClient({
      defaultOptions: { mutations: { retry: false } },
    });

    render(
      <QueryClientProvider client={client}>
        <ShareFeedbackModal
          open
          onClose={() => {}}
          initialReason="other"
          initialMessage="The app colors are ugly."
          doctorSessionId="doctor-session-123"
          doctorSessionLog="User: I have feedback\n\nFeedback Prompt: The app colors are ugly."
        />
      </QueryClientProvider>,
    );

    const user = userEvent.setup();
    await user.type(screen.getByLabelText("Email"), "user@example.com");
    await user.click(screen.getByRole("button", { name: "Submit" }));

    await waitFor(() => expect(feedbackRequests).toHaveLength(1));
    const request = feedbackRequests[0] as {
      body: { doctor_session_id?: string; logs_file?: File };
    };
    expect(request.body.doctor_session_id).toBe("doctor-session-123");
    expect(request.body.logs_file).toBeUndefined();
  });
});

describe("diagnostics capture base64 stripping", () => {
  test("strips data URIs and inline base64 from the triage capture", async () => {
    // A message row shaped like real client state: the same image carried as
    // a derived preview data URI and as inline attachment base64, embedded in
    // both capture surfaces (clientMessages and transcriptItems reference the
    // same objects). ~140 KB of base64 per copy.
    const bigBase64 = "iVBORw0KGgoAAAANSUhEUg".repeat(6400);
    const message = {
      id: "msg-1",
      role: "user",
      textSegments: ["look at this photo"],
      attachments: [
        {
          id: "att-1",
          filename: "photo.png",
          previewUrl: `data:image/png;base64,${bigBase64}`,
        },
      ],
      contentBlocks: [
        { type: "text", text: "look at this photo" },
        {
          type: "attachment",
          attachment: { id: "att-1", data: bigBase64 },
        },
      ],
    };
    (window as unknown as { _vellumDebug?: unknown })._vellumDebug = {
      chat: {
        getClientMessages: () => [message],
        getTranscriptItems: () => [{ kind: "message", key: "m1", message }],
      },
    };

    const logsText = await submitAndGetLogsText();

    expect(logsText).toContain("web-chat-debug-api-triage.json");
    // No copy of the payload survives, in either shape or either surface.
    expect(logsText).not.toContain(bigBase64);
    expect(logsText).toContain("[stripped data URI image/png,");
    expect(logsText).toContain("[stripped base64,");
    // The message ships once, via clientMessages (text appears twice there:
    // textSegments + contentBlocks). The transcript item that embeds the
    // same object by reference carries a pointer, not a second copy, and a
    // shared reference is never misread as a cycle.
    expect(logsText).not.toContain("[cyclic]");
    expect(logsText.split("look at this photo").length - 1).toBe(2);
    expect(logsText.split("[stripped data URI image/png,").length - 1).toBe(1);
    expect(logsText.split("[stripped base64,").length - 1).toBe(1);
    expect(logsText).toContain(
      "[deduplicated: see clientMessages msg-1]",
    );
    // The item-layer structure survives alongside the pointer.
    expect(logsText).toContain('"kind": "message"');
    expect(logsText).toContain('"photo.png"');
  });

  test("normal captures pass through untouched", async () => {
    // Realistic long assistant prose: sentence-shaped, well past the length
    // floor. Spaces and punctuation fail the base64 test, so it survives.
    const prose =
      "Here is a very long explanation of the failure mode. ".repeat(500);
    const message = {
      id: "msg-1",
      role: "assistant",
      textSegments: [prose],
      contentBlocks: [{ type: "text", text: prose }],
    };
    (window as unknown as { _vellumDebug?: unknown })._vellumDebug = {
      chat: {
        getClientMessages: () => [message],
        getTranscriptItems: () => [{ kind: "message", key: "m1", message }],
      },
    };

    const logsText = await submitAndGetLogsText();

    expect(logsText).toContain(prose);
    expect(logsText).not.toContain("[stripped");
  });
});

describe("dedupeAgainstClientMessages", () => {
  test("replaces identity-shared messages, keeps structurally-equal copies", () => {
    const shared = { id: "msg-1", text: "hello" };
    const copy = { id: "msg-1", text: "hello" };
    const items = [
      { kind: "message", key: "a", message: shared },
      { kind: "message", key: "b", message: copy },
      { kind: "thinking", key: "c", active: true },
    ];
    const result = dedupeAgainstClientMessages(items, [shared]) as Array<
      Record<string, unknown>
    >;

    // Identity match becomes a pointer; the item wrapper survives.
    expect(result[0]).toEqual({
      kind: "message",
      key: "a",
      message: "[deduplicated: see clientMessages msg-1]",
    });
    // A structurally-equal but distinct object is NOT deduplicated: any
    // divergence between the surfaces must be captured in full.
    expect(result[1].message).toEqual(copy);
    // Non-message items pass through untouched.
    expect(result[2]).toEqual({ kind: "thinking", key: "c", active: true });
  });

  test("passes items through when clientMessages is unavailable", () => {
    const items = [{ kind: "message", message: { id: "m" } }];
    expect(dedupeAgainstClientMessages(items, null)).toBe(items);
  });
});

describe("stripBulkBase64", () => {
  test("preserves short base64-looking strings (ids, hashes, tokens)", () => {
    const input = {
      id: "dGhpc2lzYXJlYWxpZA",
      sha: "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678",
    };
    expect(stripBulkBase64(input)).toEqual(input);
  });

  test("strips data URIs regardless of length", () => {
    expect(stripBulkBase64("data:image/jpeg;base64,abc123")).toBe(
      "[stripped data URI image/jpeg, 29 chars]",
    );
  });

  test("preserves long prose", () => {
    const prose = "The quick brown fox jumps over the lazy dog. ".repeat(500);
    expect(stripBulkBase64(prose)).toBe(prose);
  });

  test("traverses shared references in full; flags only true cycles", () => {
    // The capture's real shape: the same message object referenced from two
    // sibling arrays. Both occurrences must survive intact.
    const message = { id: "m1", text: "hello" };
    const shared = stripBulkBase64({
      clientMessages: [message],
      transcriptItems: [{ kind: "message", message }],
    }) as {
      clientMessages: unknown[];
      transcriptItems: { message: unknown }[];
    };
    expect(shared.clientMessages[0]).toEqual({ id: "m1", text: "hello" });
    expect(shared.transcriptItems[0].message).toEqual({
      id: "m1",
      text: "hello",
    });

    // A genuine cycle is replaced instead of recursing forever.
    const cyclic: Record<string, unknown> = { id: "c1" };
    cyclic.self = cyclic;
    expect(stripBulkBase64(cyclic)).toEqual({ id: "c1", self: "[cyclic]" });
  });

  test("strips long pure-base64 strings", () => {
    const b64 = "QUJDREVGR0g=".repeat(1000);
    // Padding mid-string fails the pure test; unpadded runs match.
    const unpadded = "QUJDREVGR0g".repeat(1000);
    expect(stripBulkBase64(unpadded)).toBe(
      `[stripped base64, ${unpadded.length} chars]`,
    );
    expect(stripBulkBase64(b64)).toBe(b64);
  });
});
