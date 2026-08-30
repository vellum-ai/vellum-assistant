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
import {
  parseShareInboxItem,
  type ShareInboxFileRef,
  type ShareInboxItem,
} from "@/runtime/share-inbox-parse";

export type {
  ShareInboxDestination,
  ShareInboxFileRef,
  ShareInboxItem,
} from "@/runtime/share-inbox-parse";
export { parseShareInboxItem } from "@/runtime/share-inbox-parse";

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

/**
 * Consume one inbox item. `id` names a specific write; omit it to take
 * the newest unexpired item. Returns `null` when the plugin is absent,
 * the id is gone, or the payload is empty.
 */
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
    return parseShareInboxItem(result.item);
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
