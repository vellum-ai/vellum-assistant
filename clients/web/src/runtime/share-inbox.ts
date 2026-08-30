/**
 * Bridge to the iOS shell's `ShareInbox` plugin
 * (`clients/ios/App/App/ShareInboxPlugin.swift`), which drains the App
 * Group inbox the share extension writes.
 *
 * iOS-only by design: Android has no share-extension inbox wired up.
 * A missing plugin is a no-op per the skew rule in CAPACITOR.md.
 */

import { Capacitor, registerPlugin } from "@capacitor/core";

import { publish } from "@/lib/event-bus";
import { subscribeCapacitorListener } from "@/runtime/capacitor-listener";

export type ShareInboxDestination =
  | { type: "new" }
  | { type: "thread"; threadId: string };

export interface ShareInboxFileRef {
  name: string;
  mimeType: string;
  path: string;
}

export interface ShareInboxItem {
  id: string;
  destination: ShareInboxDestination;
  text: string | null;
  files: ShareInboxFileRef[];
}

interface ShareInboxPlugin {
  consume(options: { id?: string }): Promise<{
    ok: boolean;
    item: ShareInboxItem | null;
  }>;
  addListener(
    eventName: "inboxReady",
    listener: () => void,
  ): Promise<{ remove: () => Promise<void> }>;
}

const ShareInbox = registerPlugin<ShareInboxPlugin>("ShareInbox");

function isShareInboxAvailable(): boolean {
  return Capacitor.getPlatform() === "ios";
}

function parseItem(raw: unknown): ShareInboxItem | null {
  if (raw === null || typeof raw !== "object") {
    return null;
  }
  const value = raw as Record<string, unknown>;
  if (typeof value.id !== "string" || value.id.length === 0) {
    return null;
  }
  const destination = parseDestination(value.destination);
  if (destination === null) {
    return null;
  }
  const text =
    typeof value.text === "string" && value.text.trim().length > 0
      ? value.text
      : null;
  const files = Array.isArray(value.files)
    ? value.files.flatMap((entry) => {
        if (entry === null || typeof entry !== "object") {
          return [];
        }
        const file = entry as Record<string, unknown>;
        if (
          typeof file.name !== "string" ||
          file.name.length === 0 ||
          typeof file.path !== "string" ||
          file.path.length === 0
        ) {
          return [];
        }
        return [
          {
            name: file.name,
            mimeType:
              typeof file.mimeType === "string" && file.mimeType.length > 0
                ? file.mimeType
                : "application/octet-stream",
            path: file.path,
          },
        ];
      })
    : [];
  if (text === null && files.length === 0) {
    return null;
  }
  return { id: value.id, destination, text, files };
}

function parseDestination(raw: unknown): ShareInboxDestination | null {
  if (raw === null || typeof raw !== "object") {
    return null;
  }
  const value = raw as Record<string, unknown>;
  if (value.type === "new") {
    return { type: "new" };
  }
  if (
    value.type === "thread" &&
    typeof value.threadId === "string" &&
    value.threadId.length > 0
  ) {
    return { type: "thread", threadId: value.threadId };
  }
  return null;
}

/**
 * Consume one inbox item. `id` names a specific write; omit it to take
 * the newest unexpired item. Returns `null` when the plugin is absent,
 * the id is gone, or the payload is empty.
 */
/** Read exported inbox files into `File`s the composer accepts. */
export async function readShareInboxFiles(
  files: ShareInboxFileRef[],
): Promise<File[]> {
  if (files.length === 0) {
    return [];
  }
  const { filesFromNativePaths } = await import(
    "@/domains/chat/components/chat-attachments/native-attachment-pickers"
  );
  return filesFromNativePaths(files);
}

export async function consumeShareInbox(
  id?: string | null,
): Promise<ShareInboxItem | null> {
  if (!isShareInboxAvailable()) {
    return null;
  }
  try {
    const result =
      id !== null && id !== undefined && id.length > 0
        ? await ShareInbox.consume({ id })
        : await ShareInbox.consume({});
    return parseItem(result.item);
  } catch (err) {
    console.debug("[share-inbox] ShareInbox bridge unavailable:", err);
    return null;
  }
}

/**
 * Darwin `inboxReady` and iOS resume both publish `deeplink.share` with
 * no id so the global consumer can `consumeLatest` when the command URL
 * never arrived.
 */
export function publishShareInboxSource(): () => void {
  return subscribeCapacitorListener("share_inbox", async () => {
    if (!isShareInboxAvailable()) {
      return { remove: async () => undefined };
    }
    const ready = await ShareInbox.addListener("inboxReady", () => {
      publish("deeplink.share", { inboxId: null });
    });
    const { App } = await import("@capacitor/app");
    const resume = await App.addListener("appStateChange", ({ isActive }) => {
      if (isActive) {
        publish("deeplink.share", { inboxId: null });
      }
    });
    return {
      remove: async () => {
        await ready.remove();
        await resume.remove();
      },
    };
  });
}
