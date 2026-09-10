/**
 * App icon registry: the icons an app can wear in the sidebar, the library
 * and the chat's app tiles, keyed by the Lucide kebab-case name the daemon
 * stores on the app's manifest (`app.icon`).
 *
 * Mirrors the custom-group registry (`@/domains/chat/utils/group-icon-registry`):
 * map a stored name to a module-level Lucide component once, and every
 * surface resolves through it. The assistant picks the name at `app_create`
 * from the same list, which lives on its side in
 * `assistant/src/apps/app-icons.ts`; the two lists are kept identical by
 * hand, and a name this registry does not know falls back to
 * {@link DEFAULT_APP_ICON} rather than to a broken glyph.
 *
 * Apps built before the switch carry an emoji instead. Those still render
 * as the emoji, so an old library does not turn into a wall of rockets.
 */

import {
  Activity,
  AlarmClock,
  Apple,
  Baby,
  Battery,
  Bed,
  Beer,
  Bell,
  Bike,
  Book,
  BookOpen,
  Bookmark,
  Bot,
  Brain,
  Briefcase,
  Bus,
  Cake,
  Calculator,
  Calendar,
  Camera,
  Car,
  Carrot,
  ChartBar,
  ChartLine,
  ChartPie,
  ClipboardList,
  Clock,
  Cloud,
  Code,
  Coffee,
  Compass,
  Contact,
  Cpu,
  CreditCard,
  Database,
  DollarSign,
  Droplets,
  Dumbbell,
  Egg,
  FileText,
  Film,
  Fish,
  Flag,
  Flame,
  FolderOpen,
  Gamepad2,
  Gauge,
  Gift,
  Globe,
  GraduationCap,
  Hash,
  Headphones,
  Heart,
  HeartPulse,
  House,
  Image,
  Inbox,
  Key,
  Languages,
  Layers,
  Leaf,
  Lightbulb,
  Link,
  ListChecks,
  ListTodo,
  Lock,
  Mail,
  Map,
  MapPin,
  MessageSquare,
  Mic,
  Moon,
  Mountain,
  Music,
  Newspaper,
  NotebookPen,
  Package,
  Palette,
  PartyPopper,
  PawPrint,
  PenTool,
  Pencil,
  Percent,
  Phone,
  PiggyBank,
  Pill,
  Plane,
  Play,
  Plug,
  Puzzle,
  Receipt,
  Repeat,
  Rocket,
  Ruler,
  Salad,
  Scale,
  Scissors,
  Search,
  Settings,
  Shield,
  Ship,
  Shirt,
  ShoppingCart,
  Shuffle,
  Smile,
  Snowflake,
  Sparkles,
  Speaker,
  SquareCheck,
  SquareKanban,
  Star,
  Stethoscope,
  StickyNote,
  Sun,
  Table,
  Target,
  Terminal,
  Thermometer,
  Ticket,
  Timer,
  Trophy,
  Truck,
  Tv,
  Umbrella,
  Users,
  Utensils,
  Video,
  Volume2,
  Wallet,
  Wifi,
  Wine,
  Wrench,
  Zap,
  type LucideIcon,
} from "lucide-react";

const APP_ICONS: Record<string, LucideIcon> = {
  calculator: Calculator,
  calendar: Calendar,
  "list-todo": ListTodo,
  "list-checks": ListChecks,
  "square-check": SquareCheck,
  timer: Timer,
  clock: Clock,
  "alarm-clock": AlarmClock,
  "notebook-pen": NotebookPen,
  "sticky-note": StickyNote,
  pencil: Pencil,
  "file-text": FileText,
  "clipboard-list": ClipboardList,
  bookmark: Bookmark,
  book: Book,
  "book-open": BookOpen,
  "chart-bar": ChartBar,
  "chart-line": ChartLine,
  "chart-pie": ChartPie,
  table: Table,
  "square-kanban": SquareKanban,
  database: Database,
  gauge: Gauge,
  activity: Activity,
  target: Target,
  flag: Flag,
  trophy: Trophy,
  wallet: Wallet,
  "dollar-sign": DollarSign,
  "piggy-bank": PiggyBank,
  "credit-card": CreditCard,
  receipt: Receipt,
  percent: Percent,
  "shopping-cart": ShoppingCart,
  package: Package,
  gift: Gift,
  ticket: Ticket,
  mail: Mail,
  inbox: Inbox,
  "message-square": MessageSquare,
  phone: Phone,
  bell: Bell,
  users: Users,
  contact: Contact,
  music: Music,
  headphones: Headphones,
  mic: Mic,
  video: Video,
  film: Film,
  tv: Tv,
  play: Play,
  image: Image,
  camera: Camera,
  "gamepad-2": Gamepad2,
  puzzle: Puzzle,
  "party-popper": PartyPopper,
  smile: Smile,
  map: Map,
  "map-pin": MapPin,
  compass: Compass,
  globe: Globe,
  plane: Plane,
  car: Car,
  bus: Bus,
  bike: Bike,
  ship: Ship,
  truck: Truck,
  house: House,
  bed: Bed,
  briefcase: Briefcase,
  "graduation-cap": GraduationCap,
  languages: Languages,
  brain: Brain,
  lightbulb: Lightbulb,
  heart: Heart,
  "heart-pulse": HeartPulse,
  dumbbell: Dumbbell,
  pill: Pill,
  stethoscope: Stethoscope,
  baby: Baby,
  "paw-print": PawPrint,
  utensils: Utensils,
  coffee: Coffee,
  wine: Wine,
  beer: Beer,
  cake: Cake,
  apple: Apple,
  carrot: Carrot,
  salad: Salad,
  egg: Egg,
  fish: Fish,
  cloud: Cloud,
  sun: Sun,
  moon: Moon,
  umbrella: Umbrella,
  snowflake: Snowflake,
  thermometer: Thermometer,
  droplets: Droplets,
  flame: Flame,
  leaf: Leaf,
  mountain: Mountain,
  code: Code,
  terminal: Terminal,
  cpu: Cpu,
  bot: Bot,
  wifi: Wifi,
  lock: Lock,
  key: Key,
  shield: Shield,
  settings: Settings,
  wrench: Wrench,
  plug: Plug,
  battery: Battery,
  search: Search,
  link: Link,
  hash: Hash,
  layers: Layers,
  "folder-open": FolderOpen,
  palette: Palette,
  "pen-tool": PenTool,
  ruler: Ruler,
  scale: Scale,
  scissors: Scissors,
  shirt: Shirt,
  newspaper: Newspaper,
  repeat: Repeat,
  shuffle: Shuffle,
  "volume-2": Volume2,
  speaker: Speaker,
  star: Star,
  sparkles: Sparkles,
  zap: Zap,
  rocket: Rocket,
  /* Lucide's older name for `house`, in case a model reaches for it. */
  home: House,
};

/** The names the assistant may choose from, in registry order. */
export const APP_ICON_NAMES: readonly string[] = Object.keys(APP_ICONS);

/** The glyph for an app with no icon, or one whose name is unknown here. */
export const DEFAULT_APP_ICON: LucideIcon = Rocket;

/**
 * What an app's stored icon resolves to: a Lucide component for a known
 * name, the emoji itself for a pre-registry app, or `null` for nothing
 * usable (absent, an unknown name, a stray URL). Callers that must draw
 * something fall back to {@link DEFAULT_APP_ICON}.
 */
export type AppIconGlyph =
  { kind: "icon"; Icon: LucideIcon } | { kind: "emoji"; emoji: string };

/* Pictographs, emoji-presentation characters, and the variation selector /
   keycap marks that turn a digit into an emoji (the "1234" input glyph). */
const EMOJI_PATTERN =
  /\p{Extended_Pictographic}|\p{Emoji_Presentation}|\uFE0F|\u20E3/u;

/** True when a stored icon is an emoji rather than a registry name. */
export function isEmojiIcon(icon: string): boolean {
  return EMOJI_PATTERN.test(icon);
}

export function resolveAppIcon(
  icon: string | null | undefined,
): AppIconGlyph | null {
  if (!icon) {
    return null;
  }
  const trimmed = icon.trim();
  const key = trimmed.toLowerCase();
  /* `hasOwn` rather than a bare index: an indexed read of a `Record` is typed
     as never missing, and it would also find `constructor` on the prototype. */
  const Icon = Object.hasOwn(APP_ICONS, key) ? APP_ICONS[key] : undefined;
  if (Icon) {
    return { kind: "icon", Icon };
  }
  if (isEmojiIcon(trimmed)) {
    return { kind: "emoji", emoji: trimmed };
  }
  return null;
}
