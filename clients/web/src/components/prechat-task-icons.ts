/**
 * Mapping from `prechat-tasks.ts` `iconKey` strings to lucide-react icon
 * components. Shared by the chat onboarding choice surfaces so the mapping is
 * defined once.
 *
 * This lives in a separate file from `prechat-tasks.ts` so the pure-data
 * catalog stays free of icon library imports.
 */

import {
  Calendar,
  ClipboardList,
  Pencil,
  Search,
  User,
  Wrench,
  type LucideIcon,
} from "lucide-react";

export const TASK_ICONS: Record<string, LucideIcon> = {
  wrench: Wrench,
  pencil: Pencil,
  search: Search,
  clipboardList: ClipboardList,
  calendar: Calendar,
  user: User,
};
