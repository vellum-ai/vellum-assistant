/**
 * Sidebar model for the Logs & Usage page.
 *
 * Mirrors `src/lib/settings/navigation.ts`: a flat list of items rendered
 * by `SettingsSidebarTree`, each backed by a real sub-route so the back
 * button and menu/content split work the same way as Settings.
 */

import {
  Activity,
  BarChart,
  Mail,
  ScrollText,
} from "lucide-react";

import type { SettingsSidebarItem } from "@/components/app/settings/SettingsSidebarTree.js";
import { routes } from "@/lib/routes.js";

export const LOGS_SIDEBAR: SettingsSidebarItem[] = [
  { id: "usage", label: "Usage", href: routes.logs.usage, icon: BarChart },
  { id: "logs", label: "Logs", href: routes.logs.trace, icon: ScrollText },
  { id: "emails", label: "Emails", href: routes.logs.emails, icon: Mail },
  {
    id: "system-events",
    label: "System Events",
    href: routes.logs.systemEvents,
    icon: Activity,
  },
];
