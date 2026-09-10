/**
 * The activation task catalog: what a persona's checklist offers, resolved
 * from data rather than written in code.
 *
 * Two files back it, and only they change when the content changes:
 *
 * - `lists.json` names the three starters and the remaining items of each
 *   persona list, in display order, by task id.
 * - The `activation-tasks` translation namespace holds one entry per task,
 *   keyed by that id. Copy is translatable through the normal catalog path;
 *   the structural fields beside it (`category`, `icon`, `color`, `requires`,
 *   `link.url`) are the same in every locale and translators leave them alone.
 *
 * Code reads a list's ids and a task's fields, nothing else, so editing copy,
 * prompts, chips, icons, colors, or order needs no code change and no
 * migration. Progress is keyed by task id, so an id is never reused: renaming
 * one is a new task and drops the old task's progress.
 */

import { useMemo } from "react";
import type { LucideIcon } from "lucide-react";

import { fixedT, useTranslation, type TFunction } from "@/i18n";
import { useAssistantIdentityStore } from "@/stores/assistant-identity-store";
import { useResolvedAssistantsStore } from "@/stores/resolved-assistants-store";

import {
  ACTIVATION_FALLBACK_ICON,
  resolveActivationIcon,
} from "./catalog-icons";
import listsData from "./lists.json";

/** Icon tint, from the avatar palette. `activation-task-icon.tsx` owns the
 * token pair each name resolves to. */
export const ACTIVATION_COLORS = [
  "blue",
  "teal",
  "yellow",
  "pink",
  "green",
  "orange",
  "purple",
] as const;

export type ActivationColor = (typeof ACTIVATION_COLORS)[number];

/** An external call to action rendered under a task's description. */
export interface ActivationTaskLink {
  label: string;
  url: string;
}

export interface ActivationTask {
  id: string;
  category: string;
  icon: LucideIcon;
  color: ActivationColor;
  title: string;
  description: string;
  /** Suggested-prompt chip shown when the row is expanded. */
  chip: string;
  /** What gets sent to the fresh conversation when the row is launched. */
  prompt: string;
  /** Capability tags that must be available for the row to show. */
  requires?: string[];
  link?: ActivationTaskLink;
}

export interface ActivationList {
  starters: ActivationTask[];
  items: ActivationTask[];
}

/** A list as `lists.json` stores it: task ids in display order. */
export interface ActivationListIds {
  starters: string[];
  items: string[];
}

/**
 * The display name interpolated into catalog copy that addresses the
 * assistant (teach-memory's title and description).
 *
 * Identity is the name the sidebar already shows. The resolved-assistants
 * row is the fallback when identity has not landed for this assistant yet.
 * Neither is required: a missing name becomes "your assistant" so the
 * sentence still reads, and never "it".
 */
export function resolveActivationAssistantName(
  name: string | null | undefined,
  fallback: string,
): string {
  const trimmed = name?.trim();
  return trimmed ? trimmed : fallback;
}

/** The name to interpolate, or null when nothing connected has one. */
export function readActivationAssistantName(
  assistantId: string | null,
): string | null {
  if (!assistantId) {
    return null;
  }
  const identity = useAssistantIdentityStore.getState();
  if (identity.assistantId === assistantId) {
    const identityName = identity.name?.trim();
    if (identityName) {
      return identityName;
    }
  }
  const resolved = useResolvedAssistantsStore
    .getState()
    .assistants.find((assistant) => assistant.id === assistantId)?.name;
  return resolved?.trim() || null;
}

function useActivationAssistantName(): string | null {
  const assistantId = useResolvedAssistantsStore.use.activeAssistantId();
  const identityName = useAssistantIdentityStore.use.name();
  const identityAssistantId = useAssistantIdentityStore.use.assistantId();
  const assistants = useResolvedAssistantsStore.use.assistants();
  if (!assistantId) {
    return null;
  }
  if (identityAssistantId === assistantId) {
    const trimmed = identityName?.trim();
    if (trimmed) {
      return trimmed;
    }
  }
  return (
    assistants.find((assistant) => assistant.id === assistantId)?.name?.trim() ||
    null
  );
}

function useActivationAssistantNameOrFallback(): string {
  const { t } = useTranslation("activation");
  return resolveActivationAssistantName(
    useActivationAssistantName(),
    t("catalog.assistantFallback"),
  );
}

const LISTS = listsData.lists as Record<string, ActivationListIds>;

const EMPTY_LIST_IDS: ActivationListIds = { starters: [], items: [] };

/** Every list id `lists.json` defines, in file order. */
export const ACTIVATION_CATALOG_LIST_IDS = Object.keys(LISTS);

/** Glyph used when a catalog entry names an icon the map does not carry. */
const FALLBACK_COLOR: ActivationColor = "blue";

/** The fields a task entry carries in the `activation-tasks` namespace. */
export interface RawActivationTask {
  category: string;
  icon: string;
  color: string;
  title: string;
  description: string;
  chip: string;
  prompt: string;
  requires?: string[];
  link?: ActivationTaskLink;
}

/**
 * Read one task's raw entry out of the translation namespace.
 *
 * `returnObjects` hands back the whole subtree for an object key, which is how
 * a catalog entry (copy plus its structural fields) comes back in one read. An
 * id with no entry resolves to the key path itself, which is not an object,
 * and is reported as missing.
 */
export function readRawActivationTask(
  id: string,
  t: TFunction<"activation-tasks"> = fixedT("activation-tasks"),
): RawActivationTask | null {
  const entry: unknown = t(`tasks.${id}` as never, { returnObjects: true });
  if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
    return null;
  }
  return entry as RawActivationTask;
}

function assistantDisplayName(name: string | undefined): string {
  return resolveActivationAssistantName(
    name,
    fixedT("activation")("catalog.assistantFallback"),
  );
}

function toTask(
  id: string,
  raw: RawActivationTask,
  t: TFunction<"activation-tasks">,
  name: string,
): ActivationTask {
  return {
    id,
    category: raw.category,
    // The catalog test fails on an unknown icon or color, so these fallbacks
    // only ever cover data that shipped ahead of the map.
    icon: resolveActivationIcon(raw.icon) ?? ACTIVATION_FALLBACK_ICON,
    color: (ACTIVATION_COLORS as readonly string[]).includes(raw.color)
      ? (raw.color as ActivationColor)
      : FALLBACK_COLOR,
    // Title and description may name the assistant (`{name}`). Chip and
    // prompt take the same interpolation so a later `{name}` there just
    // works; unused placeholders stay literal-free.
    title: t(`tasks.${id}.title` as never, { name }),
    description: t(`tasks.${id}.description` as never, { name }),
    chip: t(`tasks.${id}.chip` as never, { name }),
    prompt: t(`tasks.${id}.prompt` as never, { name }),
    ...(raw.requires ? { requires: raw.requires } : {}),
    // Link URLs are content. The one address the app owns elsewhere, the
    // downloads page, is pinned to `VELLUM_DOWNLOADS_URL` by `catalog.test.ts`
    // so the two cannot drift.
    ...(raw.link ? { link: raw.link } : {}),
  };
}

function resolveIds(
  ids: string[],
  t: TFunction<"activation-tasks">,
  name: string,
): ActivationTask[] {
  const tasks: ActivationTask[] = [];
  for (const id of ids) {
    const raw = readRawActivationTask(id, t);
    // An id with no entry is skipped rather than rendered as a blank row.
    if (raw) {
      tasks.push(toTask(id, raw, t, name));
    }
  }
  return tasks;
}

/**
 * The tasks of one persona list, resolved against the active locale.
 *
 * Pass the `t` a component already holds so the copy re-renders on a language
 * switch; the default binding reads the active locale but is not reactive.
 */
export function getActivationList(
  listId: string,
  t: TFunction<"activation-tasks"> = fixedT("activation-tasks"),
  name?: string,
): ActivationList {
  const ids = LISTS[listId];
  if (!ids) {
    return { starters: [], items: [] };
  }
  const resolvedName = assistantDisplayName(name);
  return {
    starters: resolveIds(ids.starters, t, resolvedName),
    items: resolveIds(ids.items, t, resolvedName),
  };
}

/**
 * One task with `{name}` already filled in. Used by the launch path, which
 * is an event handler and so reads a non-reactive binding (see `@/i18n`).
 */
export function resolveActivationTask(
  id: string,
  t: TFunction<"activation-tasks"> = fixedT("activation-tasks"),
  name?: string,
): ActivationTask | null {
  const raw = readRawActivationTask(id, t);
  if (!raw) {
    return null;
  }
  return toTask(id, raw, t, assistantDisplayName(name));
}

/** Reactive {@link getActivationList} for render paths. */
export function useActivationList(listId: string): ActivationList {
  const { t } = useTranslation("activation-tasks");
  const name = useActivationAssistantNameOrFallback();
  return useMemo(() => getActivationList(listId, t, name), [listId, t, name]);
}

/**
 * The raw ids of one list. Lets callers count a list or test membership
 * without resolving copy, and is what the contract test reads.
 */
export function getActivationListIds(listId: string): ActivationListIds {
  return LISTS[listId] ?? EMPTY_LIST_IDS;
}
