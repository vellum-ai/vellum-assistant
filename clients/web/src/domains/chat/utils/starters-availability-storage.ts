/**
 * Per-assistant record of whether the daemon has ever answered with
 * conversation starters.
 *
 * The empty state's dock reserves the chips' height before they load so their
 * arrival moves nothing above them. That trade only pays off for an assistant
 * that actually produces chips: reserving for one that produces none holds
 * ~150px and then gives it back, sliding the greeting and composer down a
 * screen that would otherwise have been perfectly still. The flag is the
 * positive signal that the reserve is worth taking, and it is persisted
 * because the question has to be answered on the first paint, before the
 * query it describes has replied.
 *
 * Display-only. A stale answer costs one animated dock open or close, never
 * correctness, so it is written on every settled answer and never migrated.
 */

import { useState } from "react";

import { createKeyedStorageAccessor } from "@/utils/typed-storage";

const storage = createKeyedStorageAccessor<boolean>({
  keyFn: (assistantId) => `vellum:startersSeen:${assistantId}`,
  scope: "user",
  parse: (raw) => raw === "true",
  serialize: (value) => (value ? "true" : "false"),
  fallback: false,
});

/**
 * Whether this assistant produced starters the last time one of its settled
 * answers was seen. False for an assistant nothing is known about yet, which
 * is the answer that keeps a fresh install motionless.
 */
export function loadAssistantProducesStarters(
  assistantId: string | null | undefined,
): boolean {
  return storage.load(assistantId ?? "");
}

/**
 * {@link loadAssistantProducesStarters} as it stood when this assistant's
 * empty state opened.
 *
 * Deliberately a snapshot rather than a subscription. The empty state is the
 * only writer, so a subscription would only ever deliver this launch's own
 * answer back to it, and a reserve that appears on that news arrives after
 * the chips it was supposed to be holding space for: it would push the group
 * that the reserve exists to keep still. The answer that matters was
 * already on disk before the screen was drawn.
 */
export function useAssistantProducedStartersAtOpen(
  assistantId: string | null | undefined,
): boolean {
  const id = assistantId ?? "";
  const [snapshot, setSnapshot] = useState(() => ({
    id,
    value: storage.load(id),
  }));
  if (snapshot.id !== id) {
    const next = { id, value: storage.load(id) };
    setSnapshot(next);
    return next.value;
  }
  return snapshot.value;
}

/** Record a settled answer from the starters query. */
export function recordAssistantProducesStarters(
  assistantId: string,
  producesStarters: boolean,
): void {
  storage.save(assistantId, producesStarters);
}
