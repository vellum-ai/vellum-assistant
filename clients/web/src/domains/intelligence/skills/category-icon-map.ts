import {
  Calendar,
  Code,
  Globe,
  Heart,
  Link2,
  type LucideIcon,
  Mail,
  MessageCircle,
  Mic,
  Palette,
  Settings,
  ShoppingCart,
  Zap,
} from "lucide-react";

const CATEGORY_ICON_MAP: Record<string, LucideIcon> = {
  mail: Mail,
  calendar: Calendar,
  "message-circle": MessageCircle,
  globe: Globe,
  zap: Zap,
  code: Code,
  mic: Mic,
  "shopping-cart": ShoppingCart,
  palette: Palette,
  heart: Heart,
  settings: Settings,
  "link-2": Link2,
};

export function resolveCategoryIcon(iconName: string): LucideIcon | undefined {
  return CATEGORY_ICON_MAP[iconName];
}
