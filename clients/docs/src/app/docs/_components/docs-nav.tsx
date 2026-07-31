"use client";

import type { Route } from "next";
import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  AlertCircle,
  AlertOctagon,
  AppWindow,
  Book,
  Boxes,
  Brain,
  Calendar,
  Cloud,
  Code,
  Download,
  FolderOpen,
  GitBranch,
  Globe,
  Hammer,
  HardDrive,
  HelpCircle,
  House,
  KeyRound,
  Layers,
  LifeBuoy,
  Lock,
  MessageSquare,
  Package,
  Puzzle,
  Rocket,
  Scale,
  Scroll,
  Search,
  Settings,
  Shield,
  ShieldCheck,
  Sparkles,
  Store,
  Wand2,
  Webhook,
  Wrench,
} from "lucide-react";
import { type ReactNode, useMemo } from "react";

import { routes } from "@/lib/routes";

import { useDocsNav } from "@/app/docs/_components/docs-nav-context";
import { NavPanelShell } from "@/app/docs/_components/nav-panel-shell";

interface DocsNavChild {
  label: string;
  href: Route | string;
  icon: ReactNode;
  children?: DocsNavChild[];
}

interface DocsNavSection {
  label: string;
  href: Route | string;
  icon: ReactNode;
  collapsedByDefault?: boolean;
  hidden?: boolean;
  children?: DocsNavChild[];
}

interface DocsNavTopLevel {
  label: string;
  href: Route | string;
  icon: ReactNode;
}

type DocsNavItem = DocsNavTopLevel | DocsNavSection;

const ICON_SIZE = 16;
const icon = (Component: typeof Book): ReactNode => (
  <Component size={ICON_SIZE} />
);

/**
 * A literal fishing hook, drawn in the lucide stroke style (24x24 grid, round
 * caps) since lucide has no fishing-hook glyph. Used for the Hooks nav item.
 */
const FishingHook = ({ size = ICON_SIZE }: { size?: number }): ReactNode => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth={2}
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    <circle cx="15" cy="4" r="2" />
    <path d="M15 6 L15 14" />
    <path d="M15 14 a5.5 5.5 0 1 1 -5.5 -5.5" />
    <path d="M9.5 8.5 l 2.6 0.7" />
  </svg>
);

const NAV_ITEMS: DocsNavItem[] = [
  { label: "Homepage", href: "/docs", icon: icon(House) },
  { label: "Constitution", href: "/docs/constitution", icon: icon(Scroll) },
  { label: "Glossary", href: "/docs/glossary", icon: icon(Book) },
  {
    label: "Getting Started",
    href: "/docs/getting-started",
    icon: icon(Rocket),
    children: [
      {
        label: "What is Vellum?",
        href: "/docs/getting-started/what-is-vellum",
        icon: icon(Sparkles),
      },
      {
        label: "Installation",
        href: "/docs/getting-started/installation",
        icon: icon(Download),
      },
      {
        label: "Quick Start",
        href: "/docs/getting-started/quick-start",
        icon: icon(Rocket),
      },
      {
        label: "Self-improving Skills",
        href: "/docs/key-concepts/self-improving-skills",
        icon: icon(Wand2),
      },
    ],
  },
  {
    label: "Key Concepts",
    href: "/docs/key-concepts",
    icon: icon(Boxes),
    children: [
      {
        label: "The Workspace",
        href: "/docs/key-concepts/the-workspace",
        icon: icon(FolderOpen),
      },
      {
        label: "Tools & Skills",
        href: "/docs/key-concepts/skills-and-tools",
        icon: icon(Wrench),
      },
      {
        label: "Memory & Context",
        href: "/docs/key-concepts/memory-and-context",
        icon: icon(Brain),
      },
      {
        label: "Model Profiles",
        href: "/docs/key-concepts/model-profiles",
        icon: icon(Boxes),
      },
      {
        label: "Channels",
        href: "/docs/key-concepts/channels",
        icon: icon(MessageSquare),
      },
      {
        label: "Scheduling",
        href: "/docs/key-concepts/scheduling",
        icon: icon(Calendar),
      },
      {
        label: "Web Search",
        href: "/docs/key-concepts/web-search",
        icon: icon(Search),
        children: [
          {
            label: "Tavily",
            href: "/docs/key-concepts/web-search/tavily",
            icon: icon(Search),
          },
          {
            label: "Perplexity",
            href: "/docs/key-concepts/web-search/perplexity",
            icon: icon(Search),
          },
          {
            label: "Brave Search",
            href: "/docs/key-concepts/web-search/brave",
            icon: icon(Search),
          },
          {
            label: "Firecrawl",
            href: "/docs/key-concepts/web-search/firecrawl",
            icon: icon(Search),
          },
        ],
      },
      {
        label: "OAuth Integrations",
        href: "/docs/key-concepts/oauth-integrations",
        icon: icon(Globe),
      },
    ],
  },
  {
    label: "Trust & Security",
    href: "/docs/trust-security",
    icon: icon(Shield),
    children: [
      {
        label: "Privacy & Data",
        href: routes.docs.legal.privacyAndData,
        icon: icon(Lock),
      },
      {
        label: "The Permissions Model",
        href: "/docs/trust-security/the-permissions-model",
        icon: icon(KeyRound),
      },
      {
        label: "Security Best Practices",
        href: "/docs/trust-security/security-best-practices",
        icon: icon(ShieldCheck),
      },
    ],
  },
  { label: "Pricing", href: "/docs/pricing", icon: icon(Scale) },
  {
    label: "Skills Reference",
    href: "/docs/skills-reference",
    icon: icon(Hammer),
    collapsedByDefault: true,
    hidden: true,
    children: [
      {
        label: "Gmail",
        href: "/docs/skills-reference/gmail",
        icon: icon(Hammer),
      },
      {
        label: "Google Calendar",
        href: "/docs/skills-reference/google-calendar",
        icon: icon(Hammer),
      },
      {
        label: "Slack",
        href: "/docs/skills-reference/slack",
        icon: icon(Hammer),
      },
      {
        label: "Messaging",
        href: "/docs/skills-reference/messaging",
        icon: icon(Hammer),
      },
      {
        label: "Phone Calls",
        href: "/docs/skills-reference/phone-calls",
        icon: icon(Hammer),
      },
      {
        label: "Browser",
        href: "/docs/skills-reference/browser",
        icon: icon(Hammer),
      },
      {
        label: "Computer Use",
        href: "/docs/skills-reference/computer-use",
        icon: icon(Hammer),
      },
      {
        label: "Screen Watch",
        href: "/docs/skills-reference/screen-watch",
        icon: icon(Hammer),
      },
      {
        label: "Image Studio",
        href: "/docs/skills-reference/image-studio",
        icon: icon(Hammer),
      },
      {
        label: "Document",
        href: "/docs/skills-reference/document",
        icon: icon(Hammer),
      },
      {
        label: "App Builder",
        href: "/docs/skills-reference/app-builder",
        icon: icon(Hammer),
      },
      {
        label: "Tasks",
        href: "/docs/skills-reference/tasks",
        icon: icon(Hammer),
      },
      {
        label: "Schedule",
        href: "/docs/skills-reference/schedule",
        icon: icon(Hammer),
      },
      {
        label: "Contacts",
        href: "/docs/skills-reference/contacts",
        icon: icon(Hammer),
      },
      {
        label: "Followups",
        href: "/docs/skills-reference/followups",
        icon: icon(Hammer),
      },
      {
        label: "Notifications",
        href: "/docs/skills-reference/notifications",
        icon: icon(Hammer),
      },
      {
        label: "Playbooks",
        href: "/docs/skills-reference/playbooks",
        icon: icon(Hammer),
      },
      {
        label: "Subagent",
        href: "/docs/skills-reference/subagent",
        icon: icon(Hammer),
      },
      {
        label: "Watcher",
        href: "/docs/skills-reference/watcher",
        icon: icon(Hammer),
      },
      {
        label: "Media Processing",
        href: "/docs/skills-reference/media-processing",
        icon: icon(Hammer),
      },
      {
        label: "Transcribe",
        href: "/docs/skills-reference/transcribe",
        icon: icon(Hammer),
      },
      {
        label: "Skill Management",
        href: "/docs/skills-reference/skill-management",
        icon: icon(Hammer),
      },
      {
        label: "ChatGPT Import",
        href: "/docs/skills-reference/chatgpt-import",
        icon: icon(Hammer),
      },
      { label: "ACP", href: "/docs/skills-reference/acp", icon: icon(Hammer) },
    ],
  },
  {
    label: "Developer Guide",
    href: "/docs/developer-guide",
    icon: icon(Code),
    children: [
      {
        label: "Get Started",
        href: "/docs/developer-guide/get-started",
        icon: icon(Rocket),
      },
      {
        label: "Architecture",
        href: "/docs/developer-guide/architecture",
        icon: icon(Layers),
      },
      {
        label: "Security & Permissions",
        href: "/docs/developer-guide/security",
        icon: icon(ShieldCheck),
      },
      {
        label: "Features & Capabilities",
        href: "/docs/developer-guide/features",
        icon: icon(Boxes),
      },
      {
        label: "API & Communication",
        href: "/docs/developer-guide/api",
        icon: icon(Code),
      },
      {
        label: "Development Workflow",
        href: "/docs/developer-guide/development-workflow",
        icon: icon(GitBranch),
      },
    ],
  },
  {
    label: "Extensibility",
    href: "/docs/extensibility",
    icon: icon(Puzzle),
    children: [
      { label: "Overview", href: "/docs/extensibility", icon: icon(Book) },
      {
        label: "Hooks",
        href: "/docs/extensibility/hooks",
        icon: <FishingHook />,
      },
      {
        label: "Tools",
        href: "/docs/extensibility/tools",
        icon: icon(Wrench),
      },
      {
        label: "Skills",
        href: "/docs/extensibility/skills",
        icon: icon(Sparkles),
      },
      {
        label: "Routes",
        href: "/docs/extensibility/routes",
        icon: icon(Webhook),
      },
      {
        label: "Apps",
        href: "/docs/extensibility/apps",
        icon: icon(AppWindow),
      },
      {
        label: "Plugins",
        href: "/docs/extensibility/plugins",
        icon: icon(Package),
      },
      {
        label: "Distribution",
        href: "/docs/extensibility/distribution",
        icon: icon(Store),
      },
    ],
  },
  {
    label: "Hosting options",
    href: "/docs/hosting-options",
    icon: icon(Globe),
    children: [
      {
        label: "Cloud hosting",
        href: "/docs/hosting-options/cloud-hosting",
        icon: icon(Cloud),
      },
      {
        label: "Local hosting",
        href: "/docs/hosting-options/local-hosting",
        icon: icon(HardDrive),
      },
      {
        label: "Advanced options",
        href: "/docs/hosting-options/advanced-options",
        icon: icon(Settings),
      },
    ],
  },
  {
    label: "Legal",
    href: routes.docs.legal.privacyPolicy,
    icon: icon(Scale),
    children: [
      {
        label: "Privacy",
        href: routes.docs.legal.privacyPolicy,
        icon: icon(Shield),
      },
      {
        label: "Terms",
        href: routes.docs.legal.termsOfUse,
        icon: icon(Scroll),
      },
      {
        label: "Prohibited Use",
        href: routes.docs.legal.prohibitedUse,
        icon: icon(AlertOctagon),
      },
    ],
  },
  {
    label: "Help",
    href: "/docs/help",
    icon: icon(LifeBuoy),
    children: [
      { label: "FAQ", href: "/docs/help/faq", icon: icon(HelpCircle) },
      {
        label: "Common Issues",
        href: "/docs/help/common-issues",
        icon: icon(AlertCircle),
      },
      {
        label: "Getting Help",
        href: "/docs/help/getting-help",
        icon: icon(LifeBuoy),
      },
    ],
  },
];

function hasChildren(item: DocsNavItem): item is DocsNavSection {
  return (
    "children" in item &&
    Array.isArray(item.children) &&
    item.children.length > 0
  );
}

function NavChildLink({
  child,
  pathname,
  onLinkClick,
}: {
  child: DocsNavChild;
  pathname: string;
  onLinkClick: () => void;
}) {
  const isActive = pathname === child.href;
  return (
    <Link
      href={child.href as never}
      onClick={onLinkClick}
      className={`flex items-center gap-2.5 rounded-md py-2 px-3 text-[14px] no-underline transition-colors ${
        isActive ? "docs-nav-link-active font-medium" : "docs-nav-link-inactive"
      }`}
    >
      <span className="docs-nav-link-icon flex shrink-0 items-center">
        {child.icon}
      </span>
      <span>{child.label}</span>
    </Link>
  );
}

function NavSection({
  item,
  pathname,
  onLinkClick,
}: {
  item: DocsNavSection;
  pathname: string;
  onLinkClick: () => void;
}) {
  const isSectionActive = pathname === item.href;

  return (
    <li className="docs-nav-section m-0 p-0">
      <Link
        href={item.href as never}
        onClick={onLinkClick}
        className={`docs-nav-section-label block px-3 pb-2 pt-3 text-[13px] font-bold tracking-normal normal-case no-underline transition-colors ${
          isSectionActive ? "docs-nav-section-label-active" : ""
        }`}
      >
        {item.label}
      </Link>
      <ul className="list-none p-0 m-0">
        {item.children?.map((child) => {
          const hasGrandchildren = child.children && child.children.length > 0;
          return (
            <li key={child.href} className="m-0 p-0">
              <NavChildLink
                child={child}
                pathname={pathname}
                onLinkClick={onLinkClick}
              />
              {hasGrandchildren && (
                <ul className="list-none p-0 m-0 pl-8">
                  {child.children!.map((grandchild) => {
                    const isGrandActive = pathname === grandchild.href;
                    return (
                      <li key={grandchild.href} className="m-0 p-0">
                        <Link
                          href={grandchild.href as never}
                          onClick={onLinkClick}
                          className={`flex items-center rounded-md py-1.5 px-3 text-[13px] no-underline transition-colors ${
                            isGrandActive
                              ? "docs-nav-link-active font-medium"
                              : "docs-nav-link-inactive"
                          }`}
                        >
                          <span>{grandchild.label}</span>
                        </Link>
                      </li>
                    );
                  })}
                </ul>
              )}
            </li>
          );
        })}
      </ul>
    </li>
  );
}

export function DocsNav() {
  const pathname = usePathname();
  const { close } = useDocsNav();

  const navItems = useMemo(
    () =>
      NAV_ITEMS.filter((item) => !("hidden" in item && item.hidden)).map(
        (item) => {
          if (hasChildren(item)) {
            return (
              <NavSection
                key={item.href}
                item={item}
                pathname={pathname}
                onLinkClick={close}
              />
            );
          }
          const isActive = pathname === item.href;
          return (
            <li key={item.href} className="m-0 p-0">
              <Link
                href={item.href as never}
                onClick={close}
                className={`flex items-center gap-2.5 rounded-md py-2 px-3 text-[14px] no-underline transition-colors ${
                  isActive
                    ? "docs-nav-link-active font-medium"
                    : "docs-nav-link-inactive"
                }`}
              >
                <span className="docs-nav-link-icon flex shrink-0 items-center">
                  {item.icon}
                </span>
                <span>{item.label}</span>
              </Link>
            </li>
          );
        },
      ),
    [pathname, close],
  );

  return (
    <NavPanelShell>
      <ul className="docs-nav-list list-none px-4 pb-4 pt-4 md:pt-8 m-0 flex-1 overflow-y-auto">
        {navItems}
      </ul>
    </NavPanelShell>
  );
}
