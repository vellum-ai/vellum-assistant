import {
  BookOpen,
  Brain,
  Calendar,
  Compass,
  Heart,
  RefreshCw,
  Users,
  Zap,
} from "lucide-react";

import type { MemoryKind } from "./types.js";

export interface MemoryKindMeta {
  kind: MemoryKind;
  label: string;
  color: string;
  icon: typeof Calendar;
}

const FUN_COLORS = {
  pink: "#DB4B77",
  teal: "#0E9B8B",
  red: "#EF4400",
  purple: "#A665C9",
  green: "#4C9B50",
  yellow: "#E9C91A",
  blue: "#3B82F6",
  coral: "#E9642F",
} as const;

export const MEMORY_KIND_META: Record<MemoryKind, MemoryKindMeta> = {
  episodic: {
    kind: "episodic",
    label: "Event",
    color: FUN_COLORS.pink,
    icon: Calendar,
  },
  semantic: {
    kind: "semantic",
    label: "Knowledge",
    color: FUN_COLORS.teal,
    icon: Brain,
  },
  procedural: {
    kind: "procedural",
    label: "Skill",
    color: FUN_COLORS.red,
    icon: Zap,
  },
  emotional: {
    kind: "emotional",
    label: "Feeling",
    color: FUN_COLORS.purple,
    icon: Heart,
  },
  prospective: {
    kind: "prospective",
    label: "Plan",
    color: FUN_COLORS.green,
    icon: Compass,
  },
  behavioral: {
    kind: "behavioral",
    label: "Pattern",
    color: FUN_COLORS.yellow,
    icon: RefreshCw,
  },
  narrative: {
    kind: "narrative",
    label: "Story",
    color: FUN_COLORS.blue,
    icon: BookOpen,
  },
  shared: {
    kind: "shared",
    label: "Shared",
    color: FUN_COLORS.coral,
    icon: Users,
  },
};

export const FILTERABLE_KINDS: MemoryKind[] = [
  "episodic",
  "semantic",
  "emotional",
  "prospective",
  "behavioral",
  "narrative",
  "shared",
];

export const USER_CREATABLE_KINDS: MemoryKind[] = [
  "episodic",
  "semantic",
  "emotional",
  "prospective",
  "behavioral",
  "narrative",
  "shared",
];

export function editableKinds(current: string): MemoryKind[] {
  const kinds: MemoryKind[] = [...USER_CREATABLE_KINDS];
  if (isMemoryKind(current) && !kinds.includes(current)) {
    kinds.push(current);
  }
  return kinds;
}

export function isMemoryKind(value: string): value is MemoryKind {
  return value in MEMORY_KIND_META;
}

export function getKindMeta(value: string): MemoryKindMeta | null {
  return isMemoryKind(value) ? MEMORY_KIND_META[value] : null;
}

export function getKindLabel(value: string): string {
  return getKindMeta(value)?.label ?? capitalize(value);
}

function capitalize(s: string): string {
  return s.length > 0 ? (s[0] ?? "").toUpperCase() + s.slice(1) : s;
}
