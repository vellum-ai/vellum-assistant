import { beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

// Linux pieces only: the helper-toast factory wiring and the Save As share
// fallback. Shared behavior is covered in packages/electron-desktop.

let saveDialogResult: { canceled: boolean; filePath?: string } = {
  canceled: true,
};
const saveDialogCalls: Array<{ defaultPath?: string }> = [];

mock.module("electron", () => ({
  app: { getAppPath: () => "/nonexistent-app-path", once: () => undefined },
  dialog: {
    showSaveDialog: (_window: unknown, options: { defaultPath?: string }) => {
      saveDialogCalls.push(options);
      return Promise.resolve(saveDialogResult);
    },
  },
  BrowserWindow: { fromWebContents: () => ({ id: 1 }) },
}));

type ShareHandler = (args: unknown[], event: unknown) => unknown;
const handlers = new Map<string, ShareHandler>();
mock.module("./ipc.client", () => ({
  handle: (channel: string, _schema: unknown, fn: ShareHandler) => {
    handlers.set(channel, fn);
  },
}));
mock.module("./logger", () => ({
  default: { info: () => undefined, warn: () => undefined },
}));
mock.module("./main-window", () => ({
  ensureVisible: () => Promise.resolve(),
}));
// The shared module imports `electron.Notification`, which does not exist
// outside an Electron runtime.
const configureNotifications = mock(
  (_options: Record<string, unknown>) => undefined,
);
mock.module("@vellumai/electron-desktop/notifications", () => ({
  configureNotifications,
  installNotifications: () => undefined,
}));

class FakeSidecarClient {
  static instances: FakeSidecarClient[] = [];
  static throwOnCall: string | null = null;
  readonly calls: Array<{ method: string; params: unknown }> = [];
  readonly listeners = new Map<string, (params: unknown) => void>();

  constructor() {
    FakeSidecarClient.instances.push(this);
  }

  onNotification(
    method: string,
    _schema: unknown,
    listener: (params: unknown) => void,
  ): () => void {
    this.listeners.set(method, listener);
    return () => undefined;
  }

  call(method: string, params?: unknown): Promise<unknown> {
    // Mirrors NativeSidecarClient.call, which throws synchronously when the
    // helper cannot be spawned.
    if (FakeSidecarClient.throwOnCall !== null) {
      throw new Error(FakeSidecarClient.throwOnCall);
    }
    this.calls.push({ method, params });
    return Promise.resolve({ success: true });
  }
}
mock.module("@vellumai/native-sidecar/supervisor", () => ({
  NativeSidecarClient: FakeSidecarClient,
}));

const { createHelperToastFactory, default: notificationsFeature } =
  await import("./features/notifications");
const { default: shareFeature, sanitizeFilename } =
  await import("./features/share");
const { DesktopCapabilityRegistry } =
  await import("@vellumai/electron-desktop/capability-registry");

beforeEach(() => {
  handlers.clear();
  saveDialogCalls.length = 0;
  saveDialogResult = { canceled: true };
  FakeSidecarClient.instances.length = 0;
  configureNotifications.mockClear();
});

describe("notifications feature", () => {
  test("falls back to Electron toasts while no helper binary is installed", () => {
    notificationsFeature.install(new DesktopCapabilityRegistry());

    expect(configureNotifications.mock.calls[0]![0]).not.toHaveProperty(
      "create",
    );
  });

  test("show sends the toast over RPC and activation events route by token", async () => {
    const create = createHelperToastFactory("/opt/vellum/vellum-linux-helper");
    const seen: Array<{ event: string; index?: number }> = [];
    const toast = create({
      title: "T",
      body: "B",
      silent: false,
      actions: [
        { type: "button", text: "Allow" },
        { type: "button", text: "Deny" },
      ],
    });
    toast.on("click", () => seen.push({ event: "click" }));
    toast.on("action", (_event: unknown, index: number) =>
      seen.push({ event: "action", index }),
    );
    toast.on("show", () => seen.push({ event: "show" }));
    toast.show();
    await Bun.sleep(0);

    const client = FakeSidecarClient.instances[0]!;
    expect(client.calls).toEqual([
      {
        method: "notifications/show",
        params: {
          token: expect.stringMatching(/^toast-/) as unknown as string,
          title: "T",
          body: "B",
          actions: [{ text: "Allow" }, { text: "Deny" }],
        },
      },
    ]);

    const { token } = client.calls[0]!.params as { token: string };
    const emit = client.listeners.get("notifications/event")!;
    emit({ token, kind: "action", actionIndex: 1 });
    emit({ token, kind: "click" });
    emit({ token: "unknown-token", kind: "click" }); // dropped
    emit({ token, kind: "action" }); // no index: dropped, never "Allow"
    expect(seen).toEqual([
      { event: "show" },
      { event: "action", index: 1 },
      { event: "click" },
    ]);
  });

  test("a synchronous client throw acks as a failed delivery", async () => {
    FakeSidecarClient.throwOnCall = "linux-helper is not available";
    try {
      const create = createHelperToastFactory("/opt/vellum/helper");
      const failures: unknown[] = [];
      const toast = create({
        title: "T",
        body: "B",
        silent: false,
        actions: [],
      });
      toast.on("failed", (_event: unknown, message: string) => {
        failures.push(message);
      });
      expect(() => toast.show()).not.toThrow();
      await Bun.sleep(0);
      expect(failures).toEqual(["linux-helper is not available"]);
    } finally {
      FakeSidecarClient.throwOnCall = null;
    }
  });
});

describe("share feature", () => {
  const installShare = (): ShareHandler => {
    shareFeature.install(new DesktopCapabilityRegistry());
    const handler = handlers.get("vellum:share:file");
    if (!handler) {
      throw new Error("share handler was not registered");
    }
    return handler;
  };

  test("sanitizeFilename strips directories and invalid characters", () => {
    expect(sanitizeFilename("../../évil<name>.txt")).toBe("évil_name_.txt");
    expect(sanitizeFilename("nested/dir/受信 rėsumė.txt")).toBe(
      "受信 rėsumė.txt",
    );
    expect(sanitizeFilename("///")).toBe("download");
  });

  test("writes the bytes to the picked path and cancelling writes nothing", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "vellum-share-test-"));
    try {
      const target = path.join(dir, "out.bin");
      saveDialogResult = { canceled: false, filePath: target };
      const bytes = new Uint8Array([1, 2, 3]);
      await installShare()([bytes, "../report:v1.pdf"], { sender: {} });
      expect(saveDialogCalls[0]!.defaultPath).toBe("report_v1.pdf");
      expect(new Uint8Array(await readFile(target))).toEqual(bytes);

      saveDialogResult = { canceled: true };
      await expect(
        installShare()([bytes, "a.txt"], { sender: {} }),
      ).resolves.toBeUndefined();
      expect(saveDialogCalls).toHaveLength(2);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
