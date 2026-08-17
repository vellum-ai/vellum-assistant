/**
 * Bridge to the iOS shell's `RecentChats` plugin
 * (`clients/ios/App/App/RecentChatsPlugin.swift`), which caches the sidebar
 * conversation list in UserDefaults so the Shortcuts app's chat picker
 * (`ChatEntityQuery`) can offer the user's chats without a network stack or
 * auth of its own. `useNativeRecentChatsSync` is the one caller.
 *
 * iOS-only by design: Android has no App Intents equivalent wired up, and
 * pushing a cache no one reads would be pure bridge traffic. Widen the gate
 * if Android ever grows a chat-targeting shortcut surface.
 */

import { Capacitor, registerPlugin } from "@capacitor/core";

export interface RecentChatSyncEntry {
  id: string;
  title: string;
}

interface RecentChatsPlugin {
  sync(options: { chats: RecentChatSyncEntry[] }): Promise<{ ok: boolean }>;
}

const RecentChats = registerPlugin<RecentChatsPlugin>("RecentChats");

export function isRecentChatsSyncAvailable(): boolean {
  return Capacitor.getPlatform() === "ios";
}

/**
 * Replace the native cache with `chats` (newest first; the caller owns
 * ordering and membership). Swallows bridge failures with a debug log per
 * the skew convention (see `apns-environment.ts`): an older installed shell
 * without the plugin is an expected state on every web deploy, not a fault.
 */
export async function syncRecentChats(
  chats: RecentChatSyncEntry[],
): Promise<void> {
  try {
    await RecentChats.sync({ chats });
  } catch (err) {
    console.debug("[recent-chats] RecentChats bridge unavailable:", err);
  }
}
