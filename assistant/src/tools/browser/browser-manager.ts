import type { CdpClientKind } from "./cdp-client/types.js";

class BrowserManager {
  private snapshotBackendNodeMaps = new Map<string, Map<string, number>>();
  private preferredBackendKinds = new Map<string, CdpClientKind>();

  clearConversation(conversationId: string): void {
    this.snapshotBackendNodeMaps.delete(conversationId);
    this.preferredBackendKinds.delete(conversationId);
  }

  clearAll(): void {
    this.snapshotBackendNodeMaps.clear();
    this.preferredBackendKinds.clear();
  }

  getPreferredBackendKind(conversationId: string): CdpClientKind | null {
    return this.preferredBackendKinds.get(conversationId) ?? null;
  }

  setPreferredBackendKind(conversationId: string, kind: CdpClientKind): void {
    this.preferredBackendKinds.set(conversationId, kind);
  }

  clearPreferredBackendKind(conversationId: string): void {
    this.preferredBackendKinds.delete(conversationId);
  }

  storeSnapshotBackendNodeMap(
    conversationId: string,
    map: Map<string, number>,
  ): void {
    this.snapshotBackendNodeMaps.set(conversationId, map);
  }

  clearSnapshotBackendNodeMap(conversationId: string): void {
    this.snapshotBackendNodeMaps.delete(conversationId);
  }

  resolveSnapshotBackendNodeId(
    conversationId: string,
    elementId: string,
  ): number | null {
    const map = this.snapshotBackendNodeMaps.get(conversationId);
    if (!map) {
      return null;
    }
    return map.get(elementId) ?? null;
  }
}

export const browserManager = new BrowserManager();
