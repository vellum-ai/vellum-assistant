import { afterEach, describe, expect, mock, test } from "bun:test";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const feedbackRequests: unknown[] = [];

mock.module("@/generated/api/@tanstack/react-query.gen", () => ({
  feedbackCreateMutation: () => ({
    mutationFn: async (request: unknown) => {
      feedbackRequests.push(request);
      return { id: "feedback-1" };
    },
  }),
}));

mock.module("@/stores/auth-store", () => ({
  useAuthStore: {
    use: {
      user: () => null,
    },
  },
}));

let electronShell = false;
mock.module("@/runtime/is-electron", () => ({
  isElectron: () => electronShell,
}));

const {
  ShareFeedbackModal,
  buildClientLogsFile,
  MAX_BUNDLE_DECOMPRESSED_BYTES,
  MAX_MAIN_LOG_BYTES,
  MAX_EXTRA_LOG_BYTES,
} = await import("@/components/share-feedback-modal");

afterEach(() => {
  cleanup();
  feedbackRequests.length = 0;
  electronShell = false;
  delete (window as unknown as { vellum?: unknown }).vellum;
});

/** Install a fake Electron feedback bridge returning `logs` from `logs()`. */
function stubElectronShell(logs: string) {
  electronShell = true;
  (window as unknown as { vellum?: unknown }).vellum = {
    feedback: {
      diagnostics: async () => ({ app: { name: "Vellum" } }),
      logs: async () => logs,
    },
  };
}

/** Split a tar buffer into its members. Mirrors `buildTarEntry`'s layout. */
function readTarMembers(tar: Uint8Array): Map<string, Uint8Array> {
  const members = new Map<string, Uint8Array>();
  const decoder = new TextDecoder();
  let offset = 0;
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512);
    const nameBytes = header.subarray(0, 100);
    const nul = nameBytes.indexOf(0);
    const name = decoder.decode(
      nul >= 0 ? nameBytes.subarray(0, nul) : nameBytes,
    );
    if (!name) {
      break;
    }
    const size =
      parseInt(
        decoder.decode(header.subarray(124, 136)).replace(/\0[\s\S]*$/, ""),
        8,
      ) || 0;
    members.set(name, tar.subarray(offset + 512, offset + 512 + size));
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  return members;
}

async function buildBundle(
  options: Parameters<typeof buildClientLogsFile>[3] = {},
): Promise<{
  tar: Uint8Array;
  members: Map<string, Uint8Array>;
}> {
  const file = await buildClientLogsFile("past_hour", null, null, options);
  expect(file).not.toBeNull();
  const buf = await new Response(
    file!.stream().pipeThrough(new DecompressionStream("gzip")),
  ).arrayBuffer();
  const tar = new Uint8Array(buf);
  return { tar, members: readTarMembers(tar) };
}

interface BudgetManifest {
  max_decompressed_bytes: number;
  entries: {
    filename: string;
    status: string;
    original_bytes: number;
    included_bytes: number;
  }[];
}

function readManifest(members: Map<string, Uint8Array>): BudgetManifest {
  const raw = members.get("web-bundle-budget.json");
  expect(raw).toBeDefined();
  return JSON.parse(new TextDecoder().decode(raw!)) as BudgetManifest;
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

describe("buildClientLogsFile bundle budget", () => {
  test("ships a normal main-process log whole", async () => {
    const logs =
      "2026-08-03 12:00:00 [info] started\n2026-08-03 12:00:01 [info] ready\n";
    stubElectronShell(logs);

    const { tar, members } = await buildBundle();

    expect(tar.length).toBeLessThanOrEqual(MAX_BUNDLE_DECOMPRESSED_BYTES);

    const mainLog = members.get("electron-main-logs.txt");
    expect(mainLog).toBeDefined();
    expect(new TextDecoder().decode(mainLog!)).toBe(logs);

    const manifest = readManifest(members);
    expect(manifest.max_decompressed_bytes).toBe(MAX_BUNDLE_DECOMPRESSED_BYTES);
    expect(manifest.entries.every((e) => e.status === "included")).toBe(true);

    const entry = manifest.entries.find(
      (e) => e.filename === "electron-main-logs.txt",
    );
    expect(entry?.original_bytes).toBe(logs.length);
    expect(entry?.included_bytes).toBe(logs.length);
  });

  test("tail-truncates an oversized main-process log and stays within budget", async () => {
    // 128-byte lines padded past the per-member ceiling, bracketed by markers
    // so the assertions can tell which end survived.
    const padding = "x".repeat(127);
    const lineCount = Math.ceil((MAX_MAIN_LOG_BYTES + 1024 * 1024) / 128);
    const logs = [
      "OLDEST_LINE_MARKER",
      ...Array.from({ length: lineCount }, () => padding),
      "NEWEST_LINE_MARKER",
    ].join("\n");
    expect(logs.length).toBeGreaterThan(MAX_MAIN_LOG_BYTES);
    stubElectronShell(logs);

    const { tar, members } = await buildBundle();

    expect(tar.length).toBeLessThanOrEqual(MAX_BUNDLE_DECOMPRESSED_BYTES);

    const mainLog = members.get("electron-main-logs.txt");
    expect(mainLog).toBeDefined();
    expect(mainLog!.length).toBeLessThanOrEqual(MAX_MAIN_LOG_BYTES);

    const text = new TextDecoder().decode(mainLog!);
    expect(text.startsWith("[vellum] Truncated to fit")).toBe(true);
    expect(text).toContain("NEWEST_LINE_MARKER");
    expect(text).not.toContain("OLDEST_LINE_MARKER");

    const manifest = readManifest(members);
    const entry = manifest.entries.find(
      (e) => e.filename === "electron-main-logs.txt",
    );
    expect(entry?.status).toBe("truncated");
    expect(entry?.original_bytes).toBe(logs.length);
    expect(entry!.included_bytes).toBeLessThan(entry!.original_bytes);

    // The structured diagnostics every report needs survive the truncation.
    expect(members.has("web-client-context.json")).toBe(true);
    expect(members.has("web-chat-diagnostics.json")).toBe(true);
    expect(members.has("electron-diagnostics.json")).toBe(true);
  });

  test("an oversized attached log cannot starve the members behind it", async () => {
    const padding = "x".repeat(127);
    const lineCount = Math.ceil(
      (MAX_BUNDLE_DECOMPRESSED_BYTES + 4 * 1024 * 1024) / 128,
    );
    const oversized = Array.from({ length: lineCount }, () => padding).join(
      "\n",
    );
    const mainLog = "2026-08-03 12:00:00 [info] ready\n";
    stubElectronShell(mainLog);

    const { tar, members } = await buildBundle({
      extraLogFiles: [{ filename: "doctor-session.txt", contents: oversized }],
    });

    expect(tar.length).toBeLessThanOrEqual(MAX_BUNDLE_DECOMPRESSED_BYTES);

    const doctorLog = members.get("doctor-session.txt");
    expect(doctorLog).toBeDefined();
    expect(doctorLog!.length).toBeLessThanOrEqual(MAX_EXTRA_LOG_BYTES);

    const entry = readManifest(members).entries.find(
      (e) => e.filename === "doctor-session.txt",
    );
    expect(entry?.status).toBe("truncated");
    expect(entry!.included_bytes).toBeLessThan(entry!.original_bytes);

    // The members offered after the attached log still make it into the
    // bundle, whole.
    expect(members.has("electron-diagnostics.json")).toBe(true);
    expect(new TextDecoder().decode(members.get("electron-main-logs.txt")!)).toBe(
      mainLog,
    );
    expect(
      readManifest(members)
        .entries.filter((e) => e.filename !== "doctor-session.txt")
        .every((e) => e.status === "included"),
    ).toBe(true);
  });
});
