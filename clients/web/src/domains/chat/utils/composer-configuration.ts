import {
  profilePickerLabel,
  type ProfilePickerEntry,
} from "@/assistant/profile-pickers";
import { t } from "@/i18n";

export const AUTONOMY_LEVELS = ["none", "low", "medium", "high"] as const;
export type Autonomy = (typeof AUTONOMY_LEVELS)[number];
export const AUTONOMY_COPY = {
  none: {
    label: "composerConfiguration.autonomy.none.label",
    hint: "composerConfiguration.autonomy.none.hint",
  },
  low: {
    label: "composerConfiguration.autonomy.low.label",
    hint: "composerConfiguration.autonomy.low.hint",
  },
  medium: {
    label: "composerConfiguration.autonomy.medium.label",
    hint: "composerConfiguration.autonomy.medium.hint",
  },
  high: {
    label: "composerConfiguration.autonomy.high.label",
    hint: "composerConfiguration.autonomy.high.hint",
  },
} as const;
export const DEFAULT_FAVORITES = [
  "auto",
  "balanced",
  "quality-optimized",
  "latency-optimized",
  "cost-optimized",
];
const BUILTIN_KEYS: Record<
  string,
  `chat:composerConfiguration.modes.${"auto" | "balanced" | "quality" | "fast" | "budget" | "experimental"}.hint`
> = {
  auto: "chat:composerConfiguration.modes.auto.hint",
  balanced: "chat:composerConfiguration.modes.balanced.hint",
  "quality-optimized": "chat:composerConfiguration.modes.quality.hint",
  "latency-optimized": "chat:composerConfiguration.modes.fast.hint",
  "cost-optimized": "chat:composerConfiguration.modes.budget.hint",
  "os-beta": "chat:composerConfiguration.modes.experimental.hint",
};

export function isBuiltinMode(entry: ProfilePickerEntry): boolean {
  return entry.source === "managed" && entry.name in BUILTIN_KEYS;
}

export function modeLabel(entry: ProfilePickerEntry): string {
  if (
    isBuiltinMode(entry) &&
    entry.name === "os-beta" &&
    (!entry.label || entry.label === "OS Beta")
  ) {
    return t("chat:composerConfiguration.modes.experimental.label");
  }
  return profilePickerLabel(entry);
}

export function modeHint(entry: ProfilePickerEntry): string {
  if (isBuiltinMode(entry)) {
    return t(BUILTIN_KEYS[entry.name]);
  }
  return (
    entry.description ||
    t("chat:composerConfiguration.customHint", {
      model: entry.model ?? entry.label ?? entry.name,
    })
  );
}

/** Selection keeps catalog order; absent and duplicate ids never consume a slot. */
export function favoriteModes(
  ids: readonly string[],
  profiles: readonly ProfilePickerEntry[],
  selected: string | null,
): ProfilePickerEntry[] {
  const available = new Map(profiles.map((entry) => [entry.name, entry]));
  const order = [...new Set([...DEFAULT_FAVORITES, ...available.keys()])];
  const names = [...new Set([...ids, ...order])]
    .filter((name) => available.has(name))
    .slice(0, 5)
    .sort((left, right) => order.indexOf(left) - order.indexOf(right));
  if (selected && available.has(selected) && !names.includes(selected)) {
    names.splice(Math.min(4, names.length), 1, selected);
  }
  return order.flatMap((name) => {
    const entry = available.get(name);
    return entry && names.includes(name) ? [entry] : [];
  });
}

/** Writes run in user-selection order, including across component remounts. */
const queues = new Map<string, Promise<unknown>>();
export async function serializeComposerWrite<T>(
  key: string,
  write: () => Promise<T>,
): Promise<T> {
  const previous = queues.get(key) ?? Promise.resolve();
  const next = previous.catch(() => undefined).then(write);
  queues.set(key, next);
  try {
    return await next;
  } finally {
    if (queues.get(key) === next) {
      queues.delete(key);
    }
  }
}
