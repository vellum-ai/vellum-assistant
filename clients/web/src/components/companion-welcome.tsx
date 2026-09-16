import {
  Button,
  cn,
  Modal,
  ShortcutKeys,
  Typography,
} from "@vellumai/design-library";
import {
  companionBoxFor,
  type SystemPermissionStatus,
  type VoiceActivityState,
} from "@vellumai/ipc-contract";
import { Check, Mic, MicOff, MonitorUp } from "lucide-react";
import { motion, useReducedMotion } from "motion/react";
import { useEffect, useMemo, useState, type ReactNode } from "react";

import {
  CompanionSurface,
  type CompanionSurfaceProps,
} from "@/components/companion-surface";
import { PeekingEyes } from "@/components/avatar/peeking-eyes";
import { useElementSize } from "@/hooks/use-element-size";
import { useTranslation } from "@/i18n";
import { pathBBox, unionBBox } from "@/utils/eye-bbox";
import { useBundledAvatarComponents } from "@/utils/use-bundled-avatar-components";

/**
 * The companion's first-use welcome, shown inside the app's own window.
 *
 * `CompanionIntro` points at the pill on the desktop. This is the step before
 * it: the user is looking at Vellum, has not met the pill yet, and needs to be
 * told there is now something outside the window, where it sits, and what the
 * two gestures are. It asks one question, whether they can talk right now, so
 * the run offers a live try only to someone able to take it. It does not ask
 * where the user works: the assistant learns that from being used. It then
 * asks for the two permissions the companion needs, the microphone and screen
 * recording.
 *
 * Left column is the step. The right column opens on a demo video, handed off
 * to by the assistant's eyes sinking out of the bottom of the panel. Every
 * later step draws the real `CompanionSurface` on a stand-in desktop in the
 * state the step describes.
 */

export interface CompanionWelcomeAnswers {
  /** `null` when the user never reached the question. */
  canTalk: boolean | null;
}

export type CompanionWelcomeStep =
  "meet" | "find" | "talk" | "setup" | "try" | "keys";

/** The permissions the setup step asks for. */
export type CompanionWelcomePermission = "microphone" | "screen";

/**
 * The run for a given answer to "can you talk". `try` asks for a spoken
 * sentence, so it exists only for someone who said they can give one. Setup is
 * in both runs: someone who cannot talk now can still grant the microphone for
 * later.
 */
const stepsFor = (canTalk: boolean | null): CompanionWelcomeStep[] =>
  canTalk === false
    ? ["meet", "find", "talk", "setup", "keys"]
    : ["meet", "find", "talk", "setup", "try", "keys"];

export interface CompanionWelcomeProps {
  open: boolean;
  /** The assistant's name, for the greeting. Unnamed copy when absent. */
  assistantName?: string;
  /** The assistant's colour, for the pill and the progress bars. */
  accentHex?: string;
  /** The creature, as `CompanionSurface` takes it. */
  character?: CompanionSurfaceProps["character"];
  avatarSrc?: string;
  /** Which step to open on. Storybook uses this to review one step alone. */
  initialStep?: CompanionWelcomeStep;
  /**
   * The demo on the first step: a short, silent recording of the companion
   * working. Absent draws the stand-in desktop in its place.
   */
  demoVideoSrc?: string;
  /** A still for the video to show until its first frame decodes. */
  demoVideoPoster?: string;
  /** Where each permission stands, from `useSystemPermissionsState()`. */
  permissions?: Partial<
    Record<CompanionWelcomePermission, SystemPermissionStatus>
  >;
  /**
   * Ask for a permission, or send the user to System Settings when it was
   * already denied. The host re-reads state and passes it back in.
   */
  onRequestPermission?: (kind: CompanionWelcomePermission) => void;
  /** Finished the run. */
  onComplete: (answers: CompanionWelcomeAnswers) => void;
  /** Closed before the end. Carries whatever was answered so far. */
  onDismiss: (answers: CompanionWelcomeAnswers) => void;
}

export function CompanionWelcome({
  open,
  assistantName,
  accentHex,
  character,
  avatarSrc,
  initialStep = "meet",
  demoVideoSrc,
  demoVideoPoster,
  permissions,
  onRequestPermission,
  onComplete,
  onDismiss,
}: CompanionWelcomeProps): ReactNode {
  const { t } = useTranslation();
  const [step, setStep] = useState<CompanionWelcomeStep>(initialStep);
  const [canTalk, setCanTalk] = useState<boolean | null>(null);
  const [tried, setTried] = useState("");

  const steps = stepsFor(canTalk);
  const index = Math.max(0, steps.indexOf(step));
  const isLast = index === steps.length - 1;
  const answers = { canTalk };

  const next = (): void => {
    if (isLast) {
      onComplete(answers);
      return;
    }
    setStep(steps[index + 1]);
  };
  const back = (): void => {
    if (index > 0) {
      setStep(steps[index - 1]);
    }
  };

  const name = assistantName?.trim() || undefined;

  return (
    <Modal.Root
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen) {
          onDismiss(answers);
        }
      }}
    >
      <Modal.Content
        size="lg"
        hideCloseButton
        // Radix focuses the first control on open, which draws a focus ring
        // on Maybe later before anyone has touched the keyboard.
        onOpenAutoFocus={(event) => event.preventDefault()}
        className="h-[min(560px,calc(100vh-2rem))] max-w-[900px] overflow-hidden"
      >
        <div className="flex min-h-0 flex-1">
          <div className="flex w-full min-w-0 flex-col p-8 md:w-[360px] md:shrink-0">
            <ProgressBars
              current={index}
              total={steps.length}
              accentHex={accentHex}
            />
            <div className="flex min-h-0 flex-1 flex-col overflow-y-auto pt-8">
              <StepCopy step={step} name={name} />
              <div className="pt-6">
                {step === "talk" && (
                  <div className="flex flex-col gap-2">
                    <TalkChoice
                      icon={<Mic className="size-4" />}
                      label={t("companionWelcome.talk.yes")}
                      hint={t("companionWelcome.talk.yesHint")}
                      selected={canTalk === true}
                      onSelect={() => {
                        setCanTalk(true);
                        setStep("setup");
                      }}
                    />
                    <TalkChoice
                      icon={<MicOff className="size-4" />}
                      label={t("companionWelcome.talk.no")}
                      hint={t("companionWelcome.talk.noHint")}
                      selected={canTalk === false}
                      onSelect={() => {
                        setCanTalk(false);
                        setStep("setup");
                      }}
                    />
                  </div>
                )}
                {step === "setup" && (
                  <div className="flex flex-col gap-2">
                    <PermissionCard
                      icon={<Mic className="size-4" />}
                      label={t("companionWelcome.setup.microphone")}
                      hint={t("companionWelcome.setup.microphoneHint")}
                      status={permissions?.microphone}
                      onRequest={() => onRequestPermission?.("microphone")}
                    />
                    <PermissionCard
                      icon={<MonitorUp className="size-4" />}
                      label={t("companionWelcome.setup.screen")}
                      hint={t("companionWelcome.setup.screenHint")}
                      status={permissions?.screen}
                      onRequest={() => onRequestPermission?.("screen")}
                    />
                  </div>
                )}
                {step === "try" && (
                  <textarea
                    // The user was just told to hold a key and speak, so the
                    // words need somewhere to land without a click first.
                    autoFocus
                    value={tried}
                    onChange={(event) => setTried(event.target.value)}
                    placeholder={t("companionWelcome.try.placeholder")}
                    rows={3}
                    className="w-full resize-none rounded-lg border border-[var(--border-base)] bg-[var(--surface-base)] p-3 text-body-medium-default text-[var(--content-default)] placeholder:text-[var(--content-tertiary)] focus:border-[var(--content-secondary)] focus:outline-none"
                  />
                )}
                {step === "keys" && <KeyList />}
              </div>
            </div>
            <div className="flex items-center justify-between pt-6">
              {index > 0 ? (
                <Button variant="ghost" onClick={back}>
                  {t("companionWelcome.back")}
                </Button>
              ) : (
                <Button variant="ghost" onClick={() => onDismiss(answers)}>
                  {t("companionWelcome.later")}
                </Button>
              )}
              {/* The talk question is answered by its cards, so it has no
                  Continue of its own. */}
              {step !== "talk" && (
                <Button variant="primary" onClick={next}>
                  {isLast
                    ? t("companionWelcome.done")
                    : step === "try" && tried.trim() === ""
                      ? t("companionWelcome.skipTry")
                      : t("companionWelcome.next")}
                </Button>
              )}
            </div>
          </div>
          <div className="hidden min-w-0 flex-1 p-2 md:block">
            {step === "meet" ? (
              <DemoPanel
                videoSrc={demoVideoSrc}
                posterSrc={demoVideoPoster}
                eyeStyle={character?.eyeStyle}
                accentHex={accentHex}
                fallback={
                  <Illustration
                    step={step}
                    accentHex={accentHex}
                    assistantName={name}
                    character={character}
                    avatarSrc={avatarSrc}
                    tried={tried}
                  />
                }
              />
            ) : (
              <Illustration
                step={step}
                accentHex={accentHex}
                assistantName={name}
                character={character}
                avatarSrc={avatarSrc}
                tried={tried}
              />
            )}
          </div>
        </div>
      </Modal.Content>
    </Modal.Root>
  );
}

function ProgressBars({
  current,
  total,
  accentHex,
}: {
  current: number;
  total: number;
  accentHex?: string;
}): ReactNode {
  const { t } = useTranslation();
  return (
    <div
      role="group"
      aria-label={t("companionWelcome.progress", {
        current: current + 1,
        total,
      })}
      className="flex items-center gap-1.5"
    >
      {Array.from({ length: total }, (_, at) => (
        <span
          key={at}
          aria-hidden
          className={cn(
            "h-1 flex-1 rounded-full transition-colors duration-300",
            accentHex ? "" : "bg-[var(--content-emphasised)]",
          )}
          style={{
            backgroundColor: accentHex,
            opacity: at <= current ? 1 : 0.18,
          }}
        />
      ))}
    </div>
  );
}

/**
 * Each step's title and body. Literal keys per step rather than a key built
 * from the step name, so the catalog types check every one.
 */
function StepCopy({
  step,
  name,
}: {
  step: CompanionWelcomeStep;
  name?: string;
}): ReactNode {
  const { t } = useTranslation();
  const copy: Record<CompanionWelcomeStep, { title: string; body: string }> = {
    meet: {
      title: name
        ? t("companionWelcome.meet.titleNamed", { name })
        : t("companionWelcome.meet.title"),
      body: t("companionWelcome.meet.body"),
    },
    find: {
      title: t("companionWelcome.find.title"),
      body: t("companionWelcome.find.body"),
    },
    talk: {
      title: t("companionWelcome.talk.title"),
      body: t("companionWelcome.talk.body"),
    },
    setup: {
      title: t("companionWelcome.setup.title"),
      body: t("companionWelcome.setup.body"),
    },
    try: {
      title: t("companionWelcome.try.title"),
      body: t("companionWelcome.try.body"),
    },
    keys: {
      title: t("companionWelcome.keys.title"),
      body: t("companionWelcome.keys.body"),
    },
  };
  return (
    <>
      <Modal.Title
        className="[&>span]:whitespace-normal text-[28px] leading-tight tracking-[0.01em]"
        style={{ fontFamily: "var(--font-serif)" }}
      >
        {copy[step].title}
      </Modal.Title>
      <Modal.Description className="mt-3 text-body-medium-lighter leading-[22px] text-[var(--content-secondary)]">
        {copy[step].body}
      </Modal.Description>
    </>
  );
}

function TalkChoice({
  icon,
  label,
  hint,
  selected,
  onSelect,
}: {
  icon: ReactNode;
  label: string;
  hint: string;
  selected: boolean;
  onSelect: () => void;
}): ReactNode {
  return (
    <button
      type="button"
      aria-pressed={selected}
      onClick={onSelect}
      className={cn(
        "flex items-center gap-3 rounded-xl border p-3.5 text-left transition-colors",
        selected
          ? "border-[var(--content-emphasised)] bg-[var(--surface-active)]"
          : "border-[var(--border-base)] hover:bg-[var(--surface-base)]",
      )}
    >
      <span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-[var(--surface-base)] text-[var(--content-default)]">
        {icon}
      </span>
      <span className="flex min-w-0 flex-col">
        <Typography
          variant="body-medium-default"
          className="text-[var(--content-emphasised)]"
        >
          {label}
        </Typography>
        <Typography
          variant="body-small-default"
          className="text-[var(--content-tertiary)]"
        >
          {hint}
        </Typography>
      </span>
    </button>
  );
}

/**
 * Accelerator strings, not copy: `ShortcutKeys` turns them into key caps. The
 * voice key is Fn by default and the in-call chords are fixed
 * (`call-chord-keys.ts`); the real modal should read the user's binding.
 */
const VOICE_KEY = "Fn";
const SHARE_KEYS = "Alt+S";
const DRAW_KEYS = "Alt+D";

/**
 * One permission: what it is for, and either that it is allowed or the control
 * that asks for it. A denied permission can no longer be asked for in the app,
 * so its control opens System Settings instead, which the host does from the
 * same callback.
 */
function PermissionCard({
  icon,
  label,
  hint,
  status,
  onRequest,
}: {
  icon: ReactNode;
  label: string;
  hint: string;
  status?: SystemPermissionStatus;
  onRequest: () => void;
}): ReactNode {
  const { t } = useTranslation();
  const granted = status === "granted";
  const denied = status === "denied" || status === "restricted";
  return (
    <div className="flex items-center gap-3 rounded-xl border border-[var(--border-base)] p-3.5">
      <span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-[var(--surface-base)] text-[var(--content-default)]">
        {icon}
      </span>
      <span className="flex min-w-0 flex-1 flex-col">
        <Typography
          variant="body-medium-default"
          className="text-[var(--content-emphasised)]"
        >
          {label}
        </Typography>
        <Typography
          variant="body-small-default"
          className="text-[var(--content-tertiary)]"
        >
          {hint}
        </Typography>
      </span>
      {granted ? (
        <span className="flex shrink-0 items-center gap-1 text-body-small-default text-[var(--content-secondary)]">
          <Check className="size-3.5" />
          {t("companionWelcome.setup.allowed")}
        </span>
      ) : (
        <Button variant="outlined" size="compact" onClick={onRequest}>
          {denied
            ? t("companionWelcome.setup.openSettings")
            : t("companionWelcome.setup.allow")}
        </Button>
      )}
    </div>
  );
}

/** How long the eyes rest at the bottom before sinking, and the sink itself. */
const EYES_REST_MS = 1200;
const EYES_SINK_S = 0.5;

/**
 * The first step's picture: the assistant's eyes peeking up from the bottom
 * edge, sinking out of sight, and the demo video fading in where they were, so
 * the creature reads as having gone into the video rather than the panel
 * cutting to one.
 *
 * Reduced motion, or an eye style the catalog does not know, skips straight to
 * the video.
 */
function DemoPanel({
  videoSrc,
  posterSrc,
  eyeStyle,
  accentHex,
  fallback,
}: {
  videoSrc?: string;
  posterSrc?: string;
  eyeStyle?: string;
  accentHex?: string;
  fallback: ReactNode;
}): ReactNode {
  const reduce = useReducedMotion();
  const { ref, size } = useElementSize();
  const components = useBundledAvatarComponents();
  const art = useMemo(() => {
    const def = components?.eyeStyles.find((each) => each.id === eyeStyle);
    if (!def) {
      return null;
    }
    return {
      paths: def.paths,
      bbox: unionBBox(def.paths.map((path) => pathBBox(path.svgPath))),
    };
  }, [components, eyeStyle]);

  const skipEyes = reduce === true || art === null;
  const [phase, setPhase] = useState<"eyes" | "sinking" | "demo">("eyes");
  useEffect(() => {
    if (skipEyes || phase !== "eyes") {
      return;
    }
    const timer = setTimeout(() => setPhase("sinking"), EYES_REST_MS);
    return () => clearTimeout(timer);
  }, [skipEyes, phase]);
  const showDemo = skipEyes || phase === "demo";

  return (
    <div
      ref={ref}
      aria-hidden
      // The panel is the creature's own colour while the eyes are in it, so
      // the eyes read as the assistant looking out rather than two white
      // shapes on a grey card, and the video covers it once it plays.
      className="relative h-full w-full overflow-hidden rounded-lg bg-[#17181b]"
      style={accentHex ? { backgroundColor: accentHex } : undefined}
    >
      <motion.div
        className="absolute inset-0"
        initial={false}
        animate={{ opacity: showDemo ? 1 : 0 }}
        transition={{ duration: 0.4 }}
      >
        {videoSrc ? (
          <video
            src={videoSrc}
            poster={posterSrc}
            // Autoplay is only allowed muted, and the demo has nothing to say
            // out loud: it plays inline, silent, on a loop.
            autoPlay={showDemo}
            muted
            loop
            playsInline
            className="h-full w-full object-cover"
          />
        ) : (
          fallback
        )}
      </motion.div>
      {!skipEyes && phase !== "demo" && art && (
        <motion.div
          className="pointer-events-none absolute inset-0"
          initial={false}
          animate={{ y: phase === "sinking" ? size.h * 0.4 : 0 }}
          transition={{ duration: EYES_SINK_S, ease: "easeIn" }}
          onAnimationComplete={() => {
            if (phase === "sinking") {
              setPhase("demo");
            }
          }}
        >
          <PeekingEyes art={art} stage={size} />
        </motion.div>
      )}
    </div>
  );
}

/** The gestures, as the keys a user presses and what each one does. */
function KeyList(): ReactNode {
  const { t } = useTranslation();
  const rows: { keys: ReactNode; label: string }[] = [
    {
      keys: (
        <span className="flex items-center gap-1.5">
          <span className="text-body-small-default text-[var(--content-tertiary)]">
            {t("companionWelcome.keys.hold")}
          </span>
          <ShortcutKeys accelerator={VOICE_KEY} platform="mac" />
        </span>
      ),
      label: t("companionWelcome.keys.dictate"),
    },
    {
      keys: (
        <span className="flex items-center gap-1.5">
          <span className="text-body-small-default text-[var(--content-tertiary)]">
            {t("companionWelcome.keys.doubleTap")}
          </span>
          <ShortcutKeys accelerator={VOICE_KEY} platform="mac" />
        </span>
      ),
      label: t("companionWelcome.keys.call"),
    },
    {
      keys: <ShortcutKeys accelerator={SHARE_KEYS} platform="mac" />,
      label: t("companionWelcome.keys.share"),
    },
    {
      keys: <ShortcutKeys accelerator={DRAW_KEYS} platform="mac" />,
      label: t("companionWelcome.keys.draw"),
    },
  ];
  return (
    <ul className="flex flex-col divide-y divide-[var(--border-base)] rounded-xl border border-[var(--border-base)]">
      {rows.map((row) => (
        <li
          key={row.label}
          className="flex items-center justify-between gap-3 px-3.5 py-2.5"
        >
          <Typography
            variant="body-medium-default"
            className="text-[var(--content-default)]"
          >
            {row.label}
          </Typography>
          {row.keys}
        </li>
      ))}
    </ul>
  );
}

/** A listening call for the keys step to draw the bar with. */
const ILLUSTRATION_CALL: VoiceActivityState = {
  phase: "listening",
  label: "",
  accentHex: "",
  muted: false,
  outputMuted: false,
  detail: "",
  approvalRequestId: "",
  assistantName: "",
};

const ILLUSTRATION_AVATAR_BOX = companionBoxFor("avatar", "large");

/** How far the surface's box is moved across the picture, by phase. */
const SURFACE_OFFSET: Partial<Record<CompanionSurfaceProps["phase"], string>> =
  {
    dictating: "-34%",
    call: "9%",
  };

/**
 * The stand-in desktop, with the real surface in the state the step is about.
 *
 * The backdrop is a desktop, not a themed surface: the pill is drawn for
 * whatever the user has on screen and is always dark, so the picture keeps a
 * desktop's colours in both app themes.
 */
function Illustration({
  step,
  accentHex,
  assistantName,
  character,
  avatarSrc,
  tried,
}: {
  step: CompanionWelcomeStep;
  accentHex?: string;
  assistantName?: string;
  character?: CompanionSurfaceProps["character"];
  avatarSrc?: string;
  tried: string;
}): ReactNode {
  const surface: Partial<CompanionSurfaceProps> & {
    phase: CompanionSurfaceProps["phase"];
  } = (() => {
    switch (step) {
      case "meet":
        return { phase: "resting" };
      case "find":
      case "talk":
      case "setup":
        return { phase: "hover", hovered: true };
      case "try":
        return {
          phase: "dictating",
          dictating: "listening",
          dictationText: tried,
        };
      case "keys":
        return {
          phase: "call",
          call: { ...ILLUSTRATION_CALL, assistantName: assistantName ?? "" },
          shareEnabled: true,
          shortcuts: {
            share: "⌥S",
            draw: "⌥D",
            muteMicrophone: "⌥M",
            muteAssistant: "⌥A",
          },
        };
    }
  })();

  return (
    <div
      aria-hidden
      className="relative h-full w-full overflow-hidden rounded-lg"
      style={{
        background:
          "linear-gradient(150deg, #c9d6e8 0%, #e9ddd0 45%, #b9c6d9 100%)",
      }}
    >
      {/* A window the user is working in, so the pill reads as sitting over
          another app rather than on a blank canvas. */}
      <div className="absolute inset-x-8 top-10 bottom-44 rounded-lg bg-white/70 shadow-lg shadow-black/10">
        <div className="flex h-7 items-center gap-1.5 border-b border-black/5 px-3">
          <span className="size-2.5 rounded-full bg-black/10" />
          <span className="size-2.5 rounded-full bg-black/10" />
          <span className="size-2.5 rounded-full bg-black/10" />
        </div>
        <div className="flex flex-col gap-2.5 p-5">
          <span className="h-2.5 w-2/3 rounded-full bg-black/10" />
          <span className="h-2.5 w-full rounded-full bg-black/5" />
          <span className="h-2.5 w-5/6 rounded-full bg-black/5" />
          <span className="h-2.5 w-3/4 rounded-full bg-black/5" />
        </div>
      </div>
      {/* The surface draws the creature at its box's centre and runs the pill
          off it, so a wide pill is moved as a whole to stay in the picture:
          dictation grows right of the creature, a call's bar centres on it
          with the creature ahead of the bar. */}
      <div
        className="absolute bottom-0 h-40 w-full transition-[left] duration-300"
        style={{ left: SURFACE_OFFSET[surface.phase] ?? "0%" }}
      >
        <CompanionSurface
          {...surface}
          accentHex={accentHex}
          assistantName={assistantName}
          character={character}
          avatarSrc={avatarSrc}
          // Larger than the desktop default and the same on every step, so
          // the creature is the subject of the picture and does not change size
          // as the run advances.
          avatarBox={ILLUSTRATION_AVATAR_BOX}
          watchEnabled
        />
      </div>
    </div>
  );
}
