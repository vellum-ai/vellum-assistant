/**
 * High-fidelity mockups for JARVIS-1632: new empty states for chat,
 * notifications, schedules, and the library.
 *
 * One idea runs through all four: an empty surface is a first-run moment, not
 * a dead end. Every scene answers three questions in order: what is this
 * surface (headline + one line), what will it look like once it is full (a
 * ghost preview built from the real row components), and what is the one tap
 * that fills it (recipe cards the assistant carries out in a conversation).
 *
 * Copy is inline here because these are design fixtures. The shipping PR moves
 * every string into the i18n catalogs.
 */
import type { Meta, StoryObj } from "@storybook/react-vite";
import {
  Bell,
  BookOpen,
  Calendar,
  CalendarDays,
  Download,
  FileText,
  Inbox,
  LayoutGrid,
  Mail,
  Mic,
  Plus,
  Sparkles,
  Sun,
  Target,
  Wrench,
} from "lucide-react";

import { Button, Tag } from "@vellumai/design-library";

import { ChatAvatar } from "@/components/avatar/chat-avatar";
import {
  EmptyStateIconWell,
  EmptyStatePreview,
  EmptyStateRecipeCard,
  EmptyStateRecipeGrid,
  EmptyStateScene,
} from "@/components/empty-state-scene";
import { ChatEmptyState } from "@/domains/chat/components/chat-empty-state";
import { ConversationStarterChip } from "@/domains/chat/components/conversation-starter-chip";
import {
  feedItem,
  FIXTURE_CONVERSATION_ID,
  FIXTURE_VALID_CONVERSATIONS,
} from "@/domains/home/feed-test-fixtures";
import { HomeRecapRow } from "@/domains/home/home-recap-row";
import { ScheduleRowShell } from "@/domains/schedules/components/schedule-row";
import { BUNDLED_COMPONENTS } from "@/utils/avatar-bundled-components";

import { SB_VIEWPORTS } from "../../.storybook/viewports";

const noop = () => {};

const MOBILE = {
  globals: { viewport: { value: "sbMobile", isRotated: false } },
  parameters: { viewport: { options: SB_VIEWPORTS } },
};

/** The assistant itself, composed from the bundled character parts. */
function AssistantHero({ size = 64 }: { size?: number }) {
  return (
    <ChatAvatar
      components={BUNDLED_COMPONENTS}
      traits={{ bodyShape: "burst", eyeStyle: "curious", color: "teal" }}
      customImageUrl={null}
      size={size}
      interactive
    />
  );
}

/** Page chrome so the scene is judged inside the width the app gives it. */
function PageFrame({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen bg-[var(--surface-base)] px-4 py-6 md:px-10">
      <div className="mx-auto max-w-3xl">{children}</div>
    </div>
  );
}

const meta = {
  title: "Empty States/JARVIS-1632",
  parameters: { layout: "fullscreen" },
} satisfies Meta;

export default meta;
type Story = StoryObj;

/* ---------------------------------------------------------------- chat --- */

/**
 * Chat, first run. Keeps the serif greeting and composer from the current
 * design and replaces the four generic starter chips with a short "get set
 * up" deck: three outcomes a new user can get in one tap, each of which the
 * assistant carries out in the conversation. The deck is only shown while
 * the assistant has nothing connected and no schedules; after that the
 * starters fall back to the generated suggestions.
 */
function ChatFirstRun() {
  return (
    <div className="flex min-h-screen flex-col justify-center bg-[var(--surface-base)] py-10">
      <div className="mx-auto flex w-full max-w-[720px] flex-col items-center gap-6 px-3 sm:px-6">
        <AssistantHero size={72} />
        <ChatEmptyState greeting="Hi, I'm Nova. Let's get you set up." />

        {/* Composer stand-in. The real `ChatComposer` is wired to stores. */}
        <div className="-mt-10 flex w-full items-center gap-3 rounded-2xl border border-[var(--border-base)] bg-[var(--surface-lift)] px-4 py-3 shadow-sm">
          <span className="flex-1 text-body-medium-lighter text-[var(--content-tertiary)]">
            What would help right now?
          </span>
          <Mic size={18} className="text-[var(--content-tertiary)]" />
          <div className="flex h-8 w-8 items-center justify-center rounded-full bg-[var(--content-default)] text-[var(--surface-lift)]">
            <Plus size={16} />
          </div>
        </div>

        <div className="flex w-full flex-col gap-3">
          <div className="flex items-center justify-between px-1">
            <span className="text-label-small-default uppercase tracking-wide text-[var(--content-tertiary)]">
              Three things to try first
            </span>
            <Tag tone="info">0 of 3</Tag>
          </div>
          <EmptyStateRecipeGrid columns={3}>
            <EmptyStateRecipeCard
              icon={Mail}
              title="Connect your inbox"
              description="I'll triage it and flag what needs you."
              meta="2 min"
              onSelect={noop}
            />
            <EmptyStateRecipeCard
              icon={Sun}
              title="Morning briefing"
              description="Calendar, inbox, and news at 8:00 every weekday."
              meta="Daily"
              onSelect={noop}
            />
            <EmptyStateRecipeCard
              icon={BookOpen}
              title="Teach me about your work"
              description="Tell me your role, projects, and how you like things done."
              onSelect={noop}
            />
          </EmptyStateRecipeGrid>
        </div>

        <div className="flex w-full flex-col gap-2">
          <span className="px-1 text-label-small-default uppercase tracking-wide text-[var(--content-tertiary)]">
            Or just ask
          </span>
          <div className="grid grid-cols-2 gap-3">
            <ConversationStarterChip
              label="Summarize this article for me"
              onSelect={noop}
            />
            <ConversationStarterChip
              label="Draft a reply to my last email"
              onSelect={noop}
            />
          </div>
        </div>
      </div>
    </div>
  );
}

export const Chat: Story = { render: () => <ChatFirstRun /> };
export const ChatMobile: Story = { ...MOBILE, render: () => <ChatFirstRun /> };

/* ------------------------------------------------------- notifications --- */

const PREVIEW_FEED = [
  feedItem({
    id: "preview-briefing",
    title: "Your morning briefing is ready",
    summary:
      "3 meetings today, 2 emails need a reply, and the Q3 planning doc was updated overnight.",
    category: "scheduling",
    urgency: "medium",
    sourceLabel: "Morning briefing",
    conversationId: FIXTURE_CONVERSATION_ID,
    timestamp: "2026-08-27T14:00:00.000Z",
    createdAt: "2026-08-27T14:00:02.000Z",
  }),
  feedItem({
    id: "preview-inbox",
    title: "2 emails need a reply",
    summary: "Drafts are ready for the vendor contract and the offsite RSVP.",
    category: "email",
    urgency: "low",
    sourceLabel: "Inbox triage",
    conversationId: FIXTURE_CONVERSATION_ID,
    timestamp: "2026-08-27T12:30:00.000Z",
    createdAt: "2026-08-27T12:30:02.000Z",
  }),
  feedItem({
    id: "preview-reminder",
    title: "Reminder: send the weekly update",
    summary: "You asked me to nudge you every Friday at 3:00 PM.",
    category: "scheduling",
    urgency: "low",
    sourceLabel: "Reminder",
    timestamp: "2026-08-22T21:00:00.000Z",
    createdAt: "2026-08-22T21:00:02.000Z",
  }),
];

function FeedPreview({ density }: { density?: "compact" | "comfortable" }) {
  return (
    <EmptyStatePreview label="Example">
      <div className="flex flex-col gap-1">
        {PREVIEW_FEED.map((item) => (
          <HomeRecapRow
            key={item.id}
            item={item}
            density={density}
            validConversationIds={FIXTURE_VALID_CONVERSATIONS}
            onSelect={noop}
            onDismiss={noop}
            onToggleRead={noop}
            onGoToThread={noop}
          />
        ))}
      </div>
    </EmptyStatePreview>
  );
}

/**
 * Notifications page. The current copy ("Updates and activity from your
 * assistant will appear here") never says where notifications come from, so
 * a new user has no way to make one. This version says it plainly, shows
 * three example rows built with the real `HomeRecapRow`, and offers the two
 * schedules that produce most notifications as one-tap recipes. The
 * secondary link funnels to Schedules (LUM-3376).
 */
function NotificationsPage() {
  return (
    <PageFrame>
      <EmptyStateScene
        hero={<AssistantHero />}
        title="Nothing to report yet."
        description="I'll post here when a schedule runs, a reminder fires, or something needs your attention."
        preview={<FeedPreview />}
        recipes={
          <EmptyStateRecipeGrid>
            <EmptyStateRecipeCard
              icon={Sun}
              title="Morning briefing"
              description="Calendar, inbox, and news, every weekday at 8:00."
              meta="Daily"
              onSelect={noop}
            />
            <EmptyStateRecipeCard
              icon={Inbox}
              title="Inbox triage"
              description="Every 2 hours, flag what needs a reply and draft it."
              meta="Every 2h"
              onSelect={noop}
            />
          </EmptyStateRecipeGrid>
        }
        secondaryAction={
          <Button variant="ghost" size="regular" leftIcon={<CalendarDays />} onClick={noop}>
            See all schedules
          </Button>
        }
      />
    </PageFrame>
  );
}

export const Notifications: Story = { render: () => <NotificationsPage /> };
export const NotificationsMobile: Story = {
  ...MOBILE,
  render: () => <NotificationsPage />,
};

/**
 * The bell popover has the same dead end at 360px wide. Compact density: no
 * preview, one recipe, one link out.
 */
function NotificationsBell() {
  return (
    <div className="flex min-h-screen items-start justify-end bg-[var(--surface-base)] p-6">
      <div className="w-[360px] rounded-xl border border-[var(--border-base)] bg-[var(--surface-lift)] shadow-lg">
        <div className="flex items-center justify-between border-b border-[var(--border-base)] px-4 py-3">
          <span className="text-body-medium-default text-[var(--content-default)]">
            Notifications
          </span>
          <Bell size={16} className="text-[var(--content-tertiary)]" />
        </div>
        <EmptyStateScene
          density="compact"
          hero={<EmptyStateIconWell icon={Bell} />}
          title="Nothing yet."
          recipes={
            <EmptyStateRecipeGrid columns={1}>
              <EmptyStateRecipeCard
                icon={Sun}
                title="Set up a morning briefing"
                description="Your first notification, tomorrow at 8:00."
                meta="Daily"
                onSelect={noop}
              />
            </EmptyStateRecipeGrid>
          }
        />
      </div>
    </div>
  );
}

export const NotificationsBellPopover: Story = {
  render: () => <NotificationsBell />,
};

/* ----------------------------------------------------------- schedules --- */

const READY_USAGE = (runCount: number, cost: number) =>
  ({
    status: "ready" as const,
    summary: {
      scheduleId: "preview",
      runCount,
      totalEstimatedCostUsd: cost,
      eventCount: runCount,
    },
  }) as const;

function SchedulesPreview() {
  return (
    <EmptyStatePreview label="Example">
      <ScheduleRowShell
        name="Morning briefing"
        metaParts={["Every weekday at 8:00 AM", "Next: tomorrow"]}
        usage={READY_USAGE(12, 0.84)}
        enabled
        onClick={noop}
        onToggle={noop}
      />
      <ScheduleRowShell
        name="Inbox triage"
        metaParts={["Every 2 hours", "Last: 40 min ago"]}
        usage={READY_USAGE(31, 1.12)}
        enabled
        onClick={noop}
        onToggle={noop}
      />
      <ScheduleRowShell
        name="Weekly review"
        metaParts={["Fridays at 4:00 PM", "Next: Fri"]}
        usage={READY_USAGE(2, 0.31)}
        enabled={false}
        onClick={noop}
        onToggle={noop}
      />
    </EmptyStatePreview>
  );
}

/**
 * Schedules. The current state offers "New Conversation" or "Create
 * schedule" with no hint of what a schedule is for. This version leads with
 * a recipe gallery (the four schedules most users end up creating), each of
 * which the assistant sets up in a conversation with sensible defaults, and
 * keeps the manual editor as the quiet secondary path.
 */
function SchedulesPage() {
  return (
    <PageFrame>
      <EmptyStateScene
        hero={<AssistantHero />}
        title="Let me run things while you're away."
        description="A schedule is a task I do on my own, on a cadence you pick. Start with one of these, or describe your own."
        preview={<SchedulesPreview />}
        recipes={
          <EmptyStateRecipeGrid>
            <EmptyStateRecipeCard
              icon={Sun}
              title="Morning briefing"
              description="Calendar, inbox, and news before your day starts."
              meta="Weekdays 8:00"
              onSelect={noop}
            />
            <EmptyStateRecipeCard
              icon={Inbox}
              title="Inbox triage"
              description="Flag what needs a reply and draft it for you."
              meta="Every 2h"
              onSelect={noop}
            />
            <EmptyStateRecipeCard
              icon={Target}
              title="Weekly review"
              description="What shipped, what slipped, what's next."
              meta="Fri 4:00 PM"
              onSelect={noop}
            />
            <EmptyStateRecipeCard
              icon={Sparkles}
              title="Something else"
              description="Tell me what to do and when. I'll set it up."
              onSelect={noop}
            />
          </EmptyStateRecipeGrid>
        }
        secondaryAction={
          <Button variant="ghost" size="regular" leftIcon={<Wrench />} onClick={noop}>
            Create one by hand
          </Button>
        }
      />
    </PageFrame>
  );
}

export const Schedules: Story = { render: () => <SchedulesPage /> };
export const SchedulesMobile: Story = {
  ...MOBILE,
  render: () => <SchedulesPage />,
};

/* ------------------------------------------------------------- library --- */

function GhostTile({
  icon: Icon,
  name,
  kind,
}: {
  icon: typeof LayoutGrid;
  name: string;
  kind: string;
}) {
  return (
    <div className="flex flex-col gap-3 rounded-xl border border-[var(--border-base)] bg-[var(--surface-lift)] p-3">
      <div className="flex h-20 items-center justify-center rounded-lg bg-[var(--surface-base)]">
        <Icon size={24} className="text-[var(--content-tertiary)]" />
      </div>
      <div className="flex flex-col gap-0.5">
        <span className="truncate text-body-small-default text-[var(--content-default)]">
          {name}
        </span>
        <span className="text-label-small-default text-[var(--content-tertiary)]">
          {kind}
        </span>
      </div>
    </div>
  );
}

function LibraryPreview() {
  return (
    <EmptyStatePreview label="Example">
      <div className="grid grid-cols-3 gap-2">
        <GhostTile icon={LayoutGrid} name="Expense tracker" kind="App" />
        <GhostTile icon={FileText} name="Q3 planning notes" kind="Document" />
        <GhostTile icon={Calendar} name="Team OKRs" kind="Document" />
      </div>
    </EmptyStatePreview>
  );
}

/**
 * Library. "Your library is empty" tells the user nothing about what a
 * library holds. This version names the two things that land here (apps the
 * assistant builds, documents it writes), shows a ghost grid of both, and
 * offers a build and a draft as one-tap recipes. Import stays as the quiet
 * path for people arriving with a `.vellum` bundle.
 */
function LibraryPage() {
  return (
    <PageFrame>
      <EmptyStateScene
        hero={<AssistantHero />}
        title="Anything I build for you lives here."
        description="Apps, documents, and files I create in our conversations show up in your library."
        preview={<LibraryPreview />}
        recipes={
          <EmptyStateRecipeGrid>
            <EmptyStateRecipeCard
              icon={LayoutGrid}
              title="Build a small app"
              description="A tracker, a dashboard, a form. Describe it and I'll make it."
              onSelect={noop}
            />
            <EmptyStateRecipeCard
              icon={FileText}
              title="Draft a document"
              description="A memo, a plan, a brief. I'll write the first pass."
              onSelect={noop}
            />
          </EmptyStateRecipeGrid>
        }
        secondaryAction={
          <Button variant="ghost" size="regular" leftIcon={<Download />} onClick={noop}>
            Import a .vellum file
          </Button>
        }
      />
    </PageFrame>
  );
}

export const Library: Story = { render: () => <LibraryPage /> };
export const LibraryMobile: Story = { ...MOBILE, render: () => <LibraryPage /> };
