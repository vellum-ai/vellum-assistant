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
import { DiscordLogo } from "@/components/icons/discord-logo";
import { GitHubLogo } from "@/components/icons/github-logo";
import { YouTubeLogo } from "@/components/icons/youtube-logo";
import { XLogo } from "@/components/icons/x-logo";
import { GITHUB_REPO_URL, useGitHubNudgeState } from "@/hooks/use-github-nudge";
import { joinDiscord } from "@/hooks/use-discord-nudge";

function HeroBanner() {
  return (
    <Card padding="lg" className="bg-[var(--surface-lift)]">
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
          <Tag tone="neutral">
            <Play className="h-3.5 w-3.5" />
            Community
          </Tag>
          <h1 className="text-[28px] font-semibold leading-tight tracking-tight text-[var(--content-emphasised)]">
            Build with us, in the open.
          </h1>
          <p className="max-w-xl text-body-medium-default text-[color:var(--content-tertiary)]">
            Vellum is built in the open with a growing community of developers,
            designers, and tinkerers. Here&apos;s how to get involved.
          </p>
        </div>
      </div>
    </Card>
  );
}

interface BenefitRowProps {
  icon: ComponentType<{
    size?: number;
    className?: string;
    "aria-hidden"?: boolean;
  }>;
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
    <Card padding="lg" className="flex-1">
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
          <Button onClick={primaryAction.onClick}>
            {primaryAction.icon}
            {primaryAction.label}
          </Button>
          {secondaryAction && (
            <Button
              variant="ghost"
              onClick={() =>
                window.open(
                  secondaryAction.href,
                  "_blank",
                  "noopener,noreferrer",
                )
              }
            >
              {secondaryAction.label}
              <ArrowUpRight className="h-3.5 w-3.5" />
            </Button>
          )}
        </div>
      </div>
    </Card>
  );
}

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
      <Card
        className="flex flex-1 flex-col gap-3 transition-shadow hover:shadow-md"
        padding="lg"
      >
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
      </Card>
    </a>
  );
}

export function CommunityPage() {
  const { handleStar } = useGitHubNudgeState();

  return (
    <div className="max-w-[940px] space-y-6">
      <HeroBanner />

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
            {
              icon: GitPullRequest,
              text: "Contribute fixes and new features",
            },
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
            {
              icon: Sparkles,
              text: "Share feedback and request features",
            },
            {
              icon: Users,
              text: "Get answers faster from the community",
            },
          ]}
          primaryAction={{
            label: "Join Discord",
            icon: (
              <DiscordLogo size={16} style={{ color: "currentColor" }} />
            ),
            onClick: joinDiscord,
          }}
        />
      </div>

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
