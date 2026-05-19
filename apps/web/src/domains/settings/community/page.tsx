
import {
  ArrowUpRight,
  Bug,
  ExternalLink,
  GitPullRequest,
  Globe,
  Heart,
  Play,
  Sparkles,
  Star,
  Users,
} from "lucide-react";
import type { ComponentType, ReactNode } from "react";

import { Button } from "@vellum/design-library/components/button";
import { Card } from "@vellum/design-library/components/card";
import { Tag } from "@vellum/design-library/components/tag";
import { DiscordLogo } from "@/components/app/icons/discord-logo.js";
import { GitHubLogo } from "@/components/app/icons/github-logo.js";
import { XLogo } from "@/components/app/icons/x-logo.js";
import { YouTubeLogo } from "@/components/app/icons/youtube-logo.js";
import { GITHUB_REPO_URL } from "@/lib/github-nudge/constants.js";
import { useGitHubNudgeState } from "@/lib/github-nudge/prefs.js";
import { joinDiscord } from "@/lib/discord-nudge/prefs.js";

// ---------------------------------------------------------------------------
// Hero banner
// ---------------------------------------------------------------------------

function HeroBanner() {
  return (
    <Card.Root padding="lg" clipContents className="bg-[var(--surface-lift)]">
      <div className="relative">
        <div
          className="pointer-events-none absolute -right-16 -top-16 h-64 w-64 rounded-full opacity-30 blur-3xl"
          style={{
            background:
              "radial-gradient(circle, var(--system-mid-weak) 0%, transparent 70%)",
          }}
          aria-hidden
        />
        <div className="relative flex flex-col items-start gap-3">
          <Tag tone="neutral" leftIcon={<Play />} className="rounded-full">
            Community
          </Tag>
          {/* typography: off-scale — hero heading is intentionally larger than text-title-large */}
          { }
          <h1 className="text-[28px] font-semibold leading-tight tracking-tight text-[var(--content-emphasised)]">
            Build with us, in the open.
          </h1>
          <p className="max-w-xl text-body-medium-default text-[color:var(--content-tertiary)]">
            Vellum is built in the open with a growing community of developers,
            designers, and tinkerers. Here&apos;s how to get involved.
          </p>
        </div>
      </div>
    </Card.Root>
  );
}

// ---------------------------------------------------------------------------
// Benefit row (shared between Open Source and Discord cards)
// ---------------------------------------------------------------------------

interface BenefitRowProps {
  icon: ComponentType<{ size?: number; className?: string; "aria-hidden"?: boolean }>;
  text: string;
}

function BenefitRow({ icon: Icon, text }: BenefitRowProps) {
  return (
    <li className="flex items-center gap-3">
      <span className="flex size-7 shrink-0 items-center justify-center rounded-md bg-[var(--surface-base)]">
        <Icon
          size={14}
          className="text-[var(--content-secondary)]"
          aria-hidden
        />
      </span>
      <span className="text-body-medium-lighter text-[color:var(--content-secondary)]">
        {text}
      </span>
    </li>
  );
}

// ---------------------------------------------------------------------------
// Feature card (Open Source / Discord)
// ---------------------------------------------------------------------------

interface FeatureCardProps {
  accentColor: string;
  label: string;
  icon: ReactNode;
  title: string;
  subtitle: string;
  benefits: ReadonlyArray<BenefitRowProps>;
  primaryAction: { label: string; icon: ReactNode; onClick: () => void };
  secondaryAction?: { label: string; href: string };
}

function FeatureCard({
  accentColor,
  label,
  icon,
  title,
  subtitle,
  benefits,
  primaryAction,
  secondaryAction,
}: FeatureCardProps) {
  return (
    <Card.Root padding="lg" className="flex-1">
      <div className="flex flex-col gap-4">
        <div className="flex items-start justify-between">
          <span
            className="flex size-10 items-center justify-center rounded-lg"
            style={{ backgroundColor: accentColor, color: "#fff" }}
          >
            {icon}
          </span>
          <span className="text-label-medium-default uppercase tracking-wider text-[color:var(--content-tertiary)]">
            {label}
          </span>
        </div>

        <div className="flex flex-col gap-1">
          <h2 className="text-title-medium text-[var(--content-emphasised)]">
            {title}
          </h2>
          <p className="text-body-medium-lighter text-[color:var(--content-tertiary)]">
            {subtitle}
          </p>
        </div>

        <ul className="flex flex-col gap-3">
          {benefits.map(({ icon: BenefitIcon, text }) => (
            <BenefitRow key={text} icon={BenefitIcon} text={text} />
          ))}
        </ul>

        <div className="flex items-center gap-2">
          <Button
            variant="primary"
            size="regular"
            leftIcon={primaryAction.icon}
            onClick={primaryAction.onClick}
          >
            {primaryAction.label}
          </Button>
          {secondaryAction && (
            <Button
              variant="ghost"
              size="regular"
              rightIcon={<ArrowUpRight size={14} />}
              onClick={() =>
                window.open(secondaryAction.href, "_blank", "noopener,noreferrer")
              }
            >
              {secondaryAction.label}
            </Button>
          )}
        </div>
      </div>
    </Card.Root>
  );
}

// ---------------------------------------------------------------------------
// Resource card (Community Hub, X, YouTube)
// ---------------------------------------------------------------------------

interface ResourceCardProps {
  icon: ReactNode;
  iconBg: string;
  title: string;
  description: string;
  href: string;
}

function ResourceCard({
  icon,
  iconBg,
  title,
  description,
  href,
}: ResourceCardProps) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="flex flex-1 cursor-pointer"
    >
      <Card.Root className="flex flex-1 flex-col gap-3 transition-shadow hover:shadow-md" padding="lg">
        <div className="flex items-start justify-between">
          <span
            className="flex size-10 items-center justify-center rounded-lg text-white"
            style={{ backgroundColor: iconBg }}
          >
            {icon}
          </span>
          <ExternalLink
            size={14}
            className="text-[var(--content-tertiary)]"
            aria-hidden
          />
        </div>
        <div className="flex flex-col gap-2">
          <span className="text-title-medium text-[var(--content-emphasised)]">
            {title}
          </span>
          <p className="text-body-medium-lighter text-[color:var(--content-tertiary)]">
            {description}
          </p>
        </div>
      </Card.Root>
    </a>
  );
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default function CommunitySettingsPage() {
  const { handleStar } = useGitHubNudgeState();

  return (
    <div className="max-w-[940px] space-y-6">
      <HeroBanner />

      {/* Open Source + Discord — side by side */}
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <FeatureCard
          accentColor="var(--content-emphasised)"
          label="Open Source"
          icon={<GitHubLogo size={20} />}
          title="Vellum is open source"
          subtitle="Read the source, star the repo, and contribute fixes and features on GitHub."
          benefits={[
            { icon: Star, text: "Star the repo to follow updates" },
            { icon: Bug, text: "Open issues and report bugs" },
            { icon: GitPullRequest, text: "Contribute fixes and new features" },
          ]}
          primaryAction={{
            label: "Star on GitHub",
            icon: <Star size={16} />,
            onClick: handleStar,
          }}
          secondaryAction={{
            label: "View source",
            href: GITHUB_REPO_URL,
          }}
        />

        <FeatureCard
          accentColor="#5865F2"
          label="Discord"
          icon={<DiscordLogo size={20} />}
          title="Join our community"
          subtitle="Talk to the team, share feedback, request features, and get answers faster."
          benefits={[
            { icon: Heart, text: "Talk directly with the team" },
            { icon: Sparkles, text: "Share feedback and request features" },
            { icon: Users, text: "Get answers faster from the community" },
          ]}
          primaryAction={{
            label: "Join Discord",
            icon: <DiscordLogo size={16} style={{ color: "currentColor" }} />,
            onClick: joinDiscord,
          }}
        />
      </div>

      {/* More from Vellum */}
      <div className="flex flex-col gap-4">
        <h2 className="text-label-medium-default uppercase tracking-wider text-[color:var(--content-tertiary)]">
          More from Vellum
        </h2>
        <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
          <ResourceCard
            icon={<Globe size={20} />}
            iconBg="#22c55e"
            title="Community Hub"
            description="Showcases, guides, and projects shared by the community."
            href="https://vellum.ai/community"
          />
          <ResourceCard
            icon={<XLogo size={20} />}
            iconBg="#0f172a"
            title="Follow on X"
            description="Product updates, releases, and behind-the-scenes."
            href="https://x.com/vellum_ai"
          />
          <ResourceCard
            icon={<YouTubeLogo size={20} />}
            iconBg="#ef4444"
            title="YouTube channel"
            description="Walkthroughs, tutorials, and product deep-dives."
            href="https://www.youtube.com/@Vellum_AI"
          />
        </div>
      </div>
    </div>
  );
}
