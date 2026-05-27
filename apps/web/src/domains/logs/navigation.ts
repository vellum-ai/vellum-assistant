import type { LucideIcon } from "lucide-react";
import {
  BarChart3,
  Mail,
  MonitorCog,
  ScrollText,
} from "lucide-react";

import { routes } from "@/utils/routes";

export interface LogsSidebarItem {
  id: string;
  label: string;
  href: string;
  icon: LucideIcon;
}

export const LOGS_SIDEBAR: LogsSidebarItem[] = [
  { id: "usage", label: "Usage", href: routes.logs.usage, icon: BarChart3 },
  { id: "logs", label: "Logs", href: routes.logs.trace, icon: ScrollText },
  { id: "emails", label: "Emails", href: routes.logs.emails, icon: Mail },
  {
    id: "system-events",
    label: "System Events",
    href: routes.logs.systemEvents,
    icon: MonitorCog,
  },
];
