/**
 * Durable per-assistant record of "this assistant finished first-run
 * onboarding", stamped where the research/personality funnel terminates.
 *
 * Device-scoped on purpose. Onboarding completion is a property of the
 * assistant, not of the session, so it must survive the logout sweep in
 * `lib/auth/session-cleanup.ts`, which deletes every `vellum:`-prefixed key.
 *
 * Deliberately depends on nothing but `typed-storage`: the resolved-assistants
 * store reads this module, so pulling `local-mode` in here would drag the
 * lockfile transport into the store's import graph. The lockfile mirror lives
 * in `stamp-assistant-onboarded.ts` instead.
 */

import { createStorageAccessor } from "@/utils/typed-storage";

/** assistantId -> ISO timestamp of the completion. */
type OnboardedRecord = Record<string, string>;

function parseRecord(raw: string): OnboardedRecord | null {
  const parsed: unknown = JSON.parse(raw);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return null;
  }
  const result: OnboardedRecord = {};
  for (const [id, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof value === "string" && value) {
      result[id] = value;
    }
  }
  return result;
}

const storage = createStorageAccessor<OnboardedRecord>({
  key: "device:onboarded_assistants",
  scope: "device",
  parse: parseRecord,
  serialize: JSON.stringify,
  fallback: {},
});

/** ISO completion timestamp for `assistantId`, or undefined when unstamped. */
export function readOnboardedAt(assistantId: string): string | undefined {
  return storage.load()[assistantId];
}

/**
 * Stamp `assistantId` as onboarded. Idempotent: an existing stamp is kept, so
 * a replayed funnel never rewrites the original completion time.
 */
export function markAssistantOnboarded(
  assistantId: string,
  at: string = new Date().toISOString(),
): void {
  const record = storage.load();
  if (record[assistantId]) {
    return;
  }
  storage.save({ ...record, [assistantId]: at });
}

/** Drop the stamp, so a retired id is not pre-marked if it is ever reused. */
export function forgetAssistantOnboarded(assistantId: string): void {
  const record = storage.load();
  if (!(assistantId in record)) {
    return;
  }
  const { [assistantId]: _removed, ...rest } = record;
  storage.save(rest);
}

/** Test seam: the underlying localStorage key. */
export const ONBOARDED_ASSISTANTS_STORAGE_KEY = storage.key;

