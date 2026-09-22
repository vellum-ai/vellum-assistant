import type { Meta, StoryObj } from "@storybook/react-vite";
import {
  ArrowRight,
  MessageCircle,
  MonitorUp,
  MousePointer2,
  X,
  type LucideIcon,
} from "lucide-react";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";

import { Button, Modal } from "@vellumai/design-library";
import {
  COMPANION_INTRO_BEATS,
  DEFAULT_COMPANION_SIZE,
  companionBoxFor,
  companionIntroCallControlFor,
  type CompanionIntroBeat,
  type CompanionIntroCallControl,
} from "@vellumai/ipc-contract";

import {
  CompanionIntro,
  INTRO_DEMO_SHORTCUTS,
  introDemoState,
  introPhase,
  introSpotlight,
} from "@/components/companion-intro";
import { containsPoint } from "@/components/companion-layout";
import { CompanionSurface } from "@/components/companion-surface";
import { useTranslation } from "@/i18n";

const ASSISTANT_NAME = "Quill";
const ACCENT_HEX = "#5eead4";
const CHARACTER = {
  bodyShape: "burst",
  eyeStyle: "curious",
  color: "teal",
} as const;
const AVATAR_BOX = companionBoxFor("avatar", DEFAULT_COMPANION_SIZE);
const OPTIONS_BOX = companionBoxFor("options", DEFAULT_COMPANION_SIZE);

interface TourAnnouncementProps {
  open: boolean;
  onStart: () => void;
  onDismiss: () => void;
}

function TourAnnouncement({
  open,
  onStart,
  onDismiss,
}: TourAnnouncementProps): ReactNode {
  const { t } = useTranslation();
  const [confirmingDismissal, setConfirmingDismissal] = useState(false);

  const startTour = (): void => {
    setConfirmingDismissal(false);
    onStart();
  };

  const dismissTour = (): void => {
    setConfirmingDismissal(false);
    onDismiss();
  };

  return (
    <Modal.Root
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen) {
          setConfirmingDismissal(true);
        }
      }}
    >
      <Modal.Content
        size="lg"
        hideCloseButton
        dismissOnOverlayClick={false}
        onOpenAutoFocus={(event) => event.preventDefault()}
        onEscapeKeyDown={(event) => {
          event.preventDefault();
          setConfirmingDismissal(true);
        }}
        className="max-w-[820px] overflow-hidden"
      >
        <div className="relative grid min-h-[500px] md:grid-cols-[1.18fr_0.82fr]">
          {!confirmingDismissal && (
            <button
              type="button"
              aria-label={t("companionTourEntry.close")}
              className="absolute top-4 right-4 z-10 flex size-8 items-center justify-center rounded-full text-[var(--content-tertiary)] transition-colors hover:bg-[var(--surface-active)] hover:text-[var(--content-default)] md:text-white/60 md:hover:bg-white/10 md:hover:text-white"
              onClick={() => setConfirmingDismissal(true)}
            >
              <X className="size-4" />
            </button>
          )}
          <div className="relative flex min-w-0 flex-col p-8 sm:p-10">
            {confirmingDismissal ? (
              <>
                <div className="flex flex-1 flex-col justify-center">
                  <Modal.Title className="[&>span]:whitespace-normal text-[32px] leading-[1.08] tracking-[0.01em]">
                    {t("companionTourEntry.confirm.title")}
                  </Modal.Title>
                  <Modal.Description className="mt-4 max-w-[390px] text-body-medium-lighter leading-6 text-[var(--content-secondary)]">
                    {t("companionTourEntry.confirm.body")}
                  </Modal.Description>
                </div>
                <div className="flex flex-wrap items-center justify-end gap-2 pt-8">
                  <Button variant="ghost" onClick={dismissTour}>
                    {t("companionTourEntry.confirm.skip")}
                  </Button>
                  <Button
                    variant="primary"
                    rightIcon={<ArrowRight className="size-4" />}
                    onClick={startTour}
                  >
                    {t("companionTourEntry.confirm.keep")}
                  </Button>
                </div>
              </>
            ) : (
              <>
                <Modal.Title className="[&>span]:whitespace-normal pr-8 text-[32px] leading-[1.08] tracking-[0.01em]">
                  {t("companionTourEntry.title")}
                </Modal.Title>
                <Modal.Description className="mt-3 max-w-[420px] text-body-medium-lighter leading-6 text-[var(--content-secondary)]">
                  {t("companionTourEntry.body")}
                </Modal.Description>

                <div className="mt-6 flex flex-col gap-2">
                  <TourValueCard
                    icon={MessageCircle}
                    title={t("companionTourEntry.cards.flow.title")}
                    body={t("companionTourEntry.cards.flow.body")}
                  />
                  <TourValueCard
                    icon={MonitorUp}
                    title={t("companionTourEntry.cards.context.title")}
                    body={t("companionTourEntry.cards.context.body")}
                  />
                  <TourValueCard
                    icon={MousePointer2}
                    title={t("companionTourEntry.cards.together.title")}
                    body={t("companionTourEntry.cards.together.body")}
                  />
                </div>

                <div className="mt-auto flex justify-end pt-8">
                  <Button
                    variant="primary"
                    rightIcon={<ArrowRight className="size-4" />}
                    onClick={startTour}
                  >
                    {t("companionTourEntry.start")}
                  </Button>
                </div>
              </>
            )}
          </div>

          <div
            className="relative hidden min-h-[500px] overflow-hidden bg-[#17191d] md:block"
            aria-label={t("companionTourEntry.previewLabel")}
          >
            <div
              className="absolute inset-0 opacity-80"
              style={{
                background:
                  "radial-gradient(circle at 68% 22%, rgba(94,234,212,.2), transparent 34%), linear-gradient(145deg, #252a32 0%, #15171b 72%)",
              }}
            />
            <div className="absolute top-10 right-8 left-8 h-60 overflow-hidden rounded-xl border border-white/10 bg-white/8 shadow-2xl shadow-black/30">
              <div className="flex h-8 items-center gap-1.5 border-b border-white/8 px-3">
                <span className="size-2 rounded-full bg-white/20" />
                <span className="size-2 rounded-full bg-white/15" />
                <span className="size-2 rounded-full bg-white/10" />
              </div>
              <div className="flex flex-col gap-3 p-5">
                <span className="h-2.5 w-2/3 rounded-full bg-white/13" />
                <span className="h-2.5 w-full rounded-full bg-white/8" />
                <span className="h-2.5 w-5/6 rounded-full bg-white/8" />
                <span className="mt-3 h-20 rounded-lg bg-white/6" />
              </div>
            </div>
            <div className="absolute inset-x-0 bottom-0 h-48">
              <CompanionSurface
                phase="hover"
                hovered
                spotlight="talk"
                assistantName={ASSISTANT_NAME}
                accentHex={ACCENT_HEX}
                character={CHARACTER}
                avatarBox={AVATAR_BOX}
                optionsBox={OPTIONS_BOX}
              />
            </div>
          </div>
        </div>
      </Modal.Content>
    </Modal.Root>
  );
}

function TourValueCard({
  icon: Icon,
  title,
  body,
}: {
  icon: LucideIcon;
  title: string;
  body: string;
}): ReactNode {
  return (
    <div className="flex items-center gap-3 rounded-xl border border-[var(--border-base)] bg-[var(--surface-base)] p-3">
      <span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-[var(--feed-digest-weak)] text-[var(--feed-digest-strong)]">
        <Icon className="size-4" />
      </span>
      <span className="flex min-w-0 flex-col">
        <span className="text-body-medium-default text-[var(--content-emphasised)]">
          {title}
        </span>
        <span className="text-body-small-default leading-5 text-[var(--content-tertiary)]">
          {body}
        </span>
      </span>
    </div>
  );
}

function AppBackdrop(): ReactNode {
  return (
    <div className="absolute inset-0 overflow-hidden bg-[var(--surface-base)]">
      <div className="flex h-12 items-center gap-3 border-b border-[var(--border-base)] px-5">
        <span className="size-7 rounded-lg bg-[var(--content-emphasised)]" />
        <span className="h-2.5 w-28 rounded-full bg-[var(--border-base)]" />
        <span className="ml-auto size-7 rounded-full bg-[var(--surface-active)]" />
      </div>
      <div className="flex h-[calc(100%-3rem)]">
        <div className="w-56 border-r border-[var(--border-base)] p-4">
          <span className="mb-6 block h-8 rounded-lg bg-[var(--surface-active)]" />
          <div className="flex flex-col gap-3">
            <span className="h-2.5 w-4/5 rounded-full bg-[var(--border-base)]" />
            <span className="h-2.5 w-full rounded-full bg-[var(--border-base)]" />
            <span className="h-2.5 w-3/5 rounded-full bg-[var(--border-base)]" />
          </div>
        </div>
        <div className="flex flex-1 items-center justify-center p-12">
          <div className="w-full max-w-xl space-y-4">
            <span className="mx-auto block size-12 rounded-full bg-[var(--surface-active)]" />
            <span className="mx-auto block h-3 w-48 rounded-full bg-[var(--border-base)]" />
            <span className="mx-auto block h-2.5 w-72 max-w-full rounded-full bg-[var(--surface-active)]" />
          </div>
        </div>
      </div>
    </div>
  );
}

function DesktopTour({ onRestart }: { onRestart: () => void }): ReactNode {
  const { t } = useTranslation();
  const [beat, setBeat] = useState<CompanionIntroBeat>(
    COMPANION_INTRO_BEATS[0],
  );
  const [hovered, setHovered] = useState(false);
  const [greeted, setGreeted] = useState(false);
  const [voiceKeyTaps, setVoiceKeyTaps] = useState(0);
  const [chordPresses, setChordPresses] = useState(0);
  const [chordControl, setChordControl] =
    useState<CompanionIntroCallControl>();
  const avatarRef = useRef<HTMLDivElement | null>(null);
  const demo = introDemoState(beat, t("companionIntro.call.line"));

  useEffect(() => {
    setGreeted(false);
  }, [beat]);

  const takeChord = useCallback(
    (control: CompanionIntroCallControl): void => {
      setChordControl(control);
      setChordPresses((total) => total + 1);
    },
    [],
  );

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Fn" || event.code === "Fn") {
        setVoiceKeyTaps((total) => total + 1);
        return;
      }
      if (!event.altKey) {
        return;
      }
      const control =
        event.key.toLowerCase() === "s"
          ? "share"
          : event.key.toLowerCase() === "d"
            ? "draw"
            : event.key.toLowerCase() === "m"
              ? "mute"
              : undefined;
      if (
        control !== undefined &&
        control === companionIntroCallControlFor(beat)
      ) {
        event.preventDefault();
        takeChord(control);
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [beat, takeChord]);

  const advance = (action: "next" | "back" | "dismiss" | "try"): void => {
    if (action === "dismiss") {
      onRestart();
      return;
    }
    if (action === "try") {
      return;
    }
    const index = COMPANION_INTRO_BEATS.indexOf(beat);
    const next =
      action === "back"
        ? COMPANION_INTRO_BEATS[Math.max(0, index - 1)]
        : COMPANION_INTRO_BEATS[index + 1];
    if (next === undefined) {
      onRestart();
      return;
    }
    setBeat(next);
  };

  return (
    <div
      data-theme="dark"
      className="absolute inset-0 overflow-hidden bg-[#20242b]"
      data-testid="desktop-tour"
      onMouseMove={(event) => {
        const avatar = avatarRef.current;
        const onAvatar =
          avatar !== null &&
          containsPoint(
            avatar.getBoundingClientRect(),
            event.clientX,
            event.clientY,
          );
        setHovered(onAvatar);
        if (onAvatar && beat === "idle") {
          setBeat("meet");
        }
      }}
      onMouseLeave={() => setHovered(false)}
    >
      <div
        className="absolute inset-0"
        style={{
          background:
            "radial-gradient(circle at 20% 20%, rgba(194,107,73,.42), transparent 32%), radial-gradient(circle at 78% 38%, rgba(73,112,159,.46), transparent 38%), linear-gradient(145deg, #1a1c22 0%, #303844 100%)",
        }}
      />
      <div className="absolute top-0 right-0 left-0 flex h-7 items-center border-b border-white/8 bg-black/20 px-4 backdrop-blur-xl">
        <span className="size-2 rounded-full bg-white/60" />
        <span className="ml-auto h-1.5 w-20 rounded-full bg-white/15" />
      </div>
      <div className="absolute top-16 right-[12%] bottom-28 left-[12%] overflow-hidden rounded-2xl border border-white/12 bg-white/88 shadow-2xl shadow-black/35">
        <div className="flex h-10 items-center gap-2 border-b border-black/8 px-4">
          <span className="size-2.5 rounded-full bg-[#ff5f57]" />
          <span className="size-2.5 rounded-full bg-[#febc2e]" />
          <span className="size-2.5 rounded-full bg-[#28c840]" />
        </div>
        <div className="grid h-full grid-cols-[180px_1fr]">
          <div className="border-r border-black/6 bg-black/3 p-5">
            <span className="mb-6 block h-7 rounded-lg bg-black/6" />
            <div className="space-y-3">
              <span className="block h-2 w-3/4 rounded-full bg-black/9" />
              <span className="block h-2 w-full rounded-full bg-black/6" />
              <span className="block h-2 w-2/3 rounded-full bg-black/6" />
            </div>
          </div>
          <div className="p-10">
            <span className="mb-5 block h-4 w-1/3 rounded-full bg-black/10" />
            <span className="mb-3 block h-2.5 w-full rounded-full bg-black/6" />
            <span className="block h-2.5 w-4/5 rounded-full bg-black/6" />
          </div>
        </div>
      </div>
      <CompanionSurface
        phase={introPhase(beat) ?? "resting"}
        hovered={hovered}
        spotlight={introSpotlight(beat)}
        avatarStaged={beat === "talk" || beat === "try"}
        avatarTucked={beat === "idle"}
        assistantName={ASSISTANT_NAME}
        accentHex={ACCENT_HEX}
        character={CHARACTER}
        avatarBox={AVATAR_BOX}
        optionsBox={OPTIONS_BOX}
        call={demo?.call}
        sharing={demo?.sharing}
        shareEnabled={demo !== null}
        shortcuts={demo !== null ? INTRO_DEMO_SHORTCUTS : undefined}
        avatarRef={avatarRef}
        onAvatarClick={() => {
          if (beat === "talk") {
            setGreeted(true);
          } else if (beat === "try") {
            onRestart();
          }
        }}
        onShare={() => takeChord("share")}
        onAnnotate={() => takeChord("draw")}
        onControl={(action) => {
          if (action === "muteMicrophone" || action === "unmuteMicrophone") {
            takeChord("mute");
          }
        }}
        intro={
          <CompanionIntro
            beat={beat}
            assistantName={ASSISTANT_NAME}
            accentHex={ACCENT_HEX}
            avatarBox={AVATAR_BOX}
            optionsBox={OPTIONS_BOX}
            greeted={greeted}
            voiceKeyTaps={voiceKeyTaps}
            chordPresses={chordPresses}
            chordControl={chordControl}
            onAdvance={advance}
          />
        }
      />
    </div>
  );
}

function TourEntryStory({
  announcementOnly = false,
}: {
  announcementOnly?: boolean;
}): ReactNode {
  const { t } = useTranslation();
  const [stage, setStage] = useState<"announcement" | "tour" | "dismissed">(
    "announcement",
  );

  return (
    <div className="relative h-screen min-h-[620px] w-full overflow-hidden">
      <AppBackdrop />
      {stage === "tour" ? (
        <DesktopTour onRestart={() => setStage("announcement")} />
      ) : null}
      <TourAnnouncement
        open={stage === "announcement"}
        onStart={() => {
          if (!announcementOnly) {
            setStage("tour");
          }
        }}
        onDismiss={() => setStage("dismissed")}
      />
      {stage === "dismissed" ? (
        <div className="absolute right-5 bottom-5">
          <Button variant="outlined" onClick={() => setStage("announcement")}>
            {t("companionTourEntry.reopen")}
          </Button>
        </div>
      ) : null}
    </div>
  );
}

const meta: Meta<typeof TourEntryStory> = {
  title: "Companion/Tour entry",
  component: TourEntryStory,
  parameters: { layout: "fullscreen", controls: { disable: true } },
};

export default meta;
type Story = StoryObj<typeof TourEntryStory>;

/** The proposed sequence: announce the tour, then hand off to the real tour. */
export const HandoffIntoTour: Story = {};

/** The announcement by itself, for reviewing the modal without the handoff. */
export const AnnouncementOnly: Story = {
  args: { announcementOnly: true },
};

/** The same announcement on the app's dark theme. */
export const AnnouncementDark: Story = {
  args: { announcementOnly: true },
  globals: { theme: "dark" },
};
