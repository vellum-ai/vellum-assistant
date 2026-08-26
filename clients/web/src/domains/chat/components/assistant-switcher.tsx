/**
 * The sidebar's ambient assistant switcher (Figma 7984:9239). The identity
 * pill gains a circular chevron when more than one assistant is reachable,
 * and the chevron expands the pill in place into a lifted card listing every
 * switchable assistant: the current one checked, the rest one tap from
 * becoming the selection. Selecting switches through the kind-aware connect
 * path and collapses back to the pill, which retints to the new assistant
 * once the lifecycle republishes; the content area's assistant gate carries
 * the loading state, so the sidebar stays put.
 *
 * With fewer than two switchable assistants, a closed flag gate, or the
 * collapsed rail, it renders the plain `AssistantNavItem` untouched.
 */

import { ChevronDown, ChevronUp } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import { motion, useReducedMotion } from "motion/react";
import { useTranslation } from "react-i18next";
import { useLocation, useNavigate } from "react-router";

import { cn, toast } from "@vellumai/design-library";

import { switchToResolvedAssistant } from "@/assistant/switch-service";
import { useSwitchableAssistants } from "@/assistant/use-switchable-assistants";
import { AssistantNavItem } from "@/domains/chat/components/assistant-nav-item";
import { AssistantSwitcherRow } from "@/domains/chat/components/assistant-switcher-row";
import { canFetchRowAvatarViaPlatformProxy } from "@/hooks/use-chooser-row-avatar";
import { versionSupportsAvatarStateManifest } from "@/lib/backwards-compat/avatar-state-manifest";
import { captureError } from "@/lib/sentry/capture-error";
import { useConversationStore } from "@/stores/conversation-store";
import type { ResolvedAssistant } from "@/stores/resolved-assistants-store";
import { routes } from "@/utils/routes";

interface AssistantSwitcherProps {
  assistantId: string | null;
  label: string;
  active: boolean;
  collapsed?: boolean;
  onSelect?: () => void;
  /** Renders the "New Chat" row below the assistant row. */
  onNewConversation?: () => void;
  /**
   * Called after a successful switch. The overlay drawer passes its close
   * callback here so the switch reveals the new assistant, the way every
   * other drawer row dismisses on selection; a failed switch keeps the
   * drawer (and the card) open for a retry.
   */
  onSwitched?: () => void;
  /** Mounts with the card open. Stories only; the app always starts closed. */
  defaultExpanded?: boolean;
}

export function AssistantSwitcher({
  defaultExpanded = false,
  onSwitched,
  ...props
}: AssistantSwitcherProps) {
  const { assistantId, label, collapsed = false } = props;
  const { t } = useTranslation("chat");
  const { assistants, canSwitch } = useSwitchableAssistants();
  const [expanded, setExpanded] = useState(defaultExpanded);
  const [switchingId, setSwitchingId] = useState<string | null>(null);
  const reduce = useReducedMotion();
  const listId = useId();
  const navigate = useNavigate();
  const location = useLocation();

  /* Toggling swaps the tree holding the focused chevron (pill vs card),
     which unmounts it and drops keyboard focus on the document. Every
     user-driven toggle bumps this request, and the effect re-anchors focus
     on whichever chevron the commit mounted. A counter rather than a flag
     keyed on `expanded`: the collapse racing a mid-switch publication (the
     auto-collapse below) leaves `expanded` unchanged by the time the
     success path runs, and a flag would then wait, stale, to steal focus
     from an unrelated background collapse. */
  const chevronRef = useRef<HTMLButtonElement | null>(null);
  const [chevronFocusRequest, setChevronFocusRequest] = useState(0);
  const requestChevronFocus = () => {
    setChevronFocusRequest((count) => count + 1);
  };
  useEffect(() => {
    if (chevronFocusRequest === 0) {
      return;
    }
    chevronRef.current?.focus();
  }, [chevronFocusRequest]);

  /* A completed switch, a shrinking list, and the rail collapsing all fold
     the card away: the pill (or the rail's tile) is the only resting state.
     Skipped on mount so `defaultExpanded` survives its first render. When
     the fold is the target assistant publishing mid-switch it carries the
     focus handoff a user toggle gets; a background fold never steals
     focus. */
  const switchingIdRef = useRef<string | null>(null);
  const mounted = useRef(false);
  useEffect(() => {
    if (!mounted.current) {
      mounted.current = true;
      return;
    }
    setExpanded(false);
    if (switchingIdRef.current !== null) {
      requestChevronFocus();
    }
  }, [assistantId, canSwitch, collapsed]);

  if (!canSwitch || collapsed) {
    return <AssistantNavItem {...props} />;
  }

  const others = assistants.filter((a) => a.id !== assistantId);
  const switching = switchingId !== null;

  const handleSwitch = async (assistant: ResolvedAssistant) => {
    if (switching) {
      return;
    }
    setSwitchingId(assistant.id);
    switchingIdRef.current = assistant.id;
    /* Leave the old assistant's conversation behind BEFORE the connect, not
       after it resolves: every connect path publishes the selection before
       its promise finishes, and the loader gives an explicit URL
       conversation id top priority even across an assistant switch, so a
       reset deferred to the await races the loader applying, and
       persisting, the old assistant's conversation against the new one.
       Landing on the assistant route lets the loader resolve the new
       assistant's own last-viewed conversation, the same landing the
       chooser screen navigates to. */
    const previousConversationId =
      useConversationStore.getState().activeConversationId;
    const previousPath = `${location.pathname}${location.search}${location.hash}`;
    useConversationStore.getState().setActiveConversationId(null);
    try {
      /* Awaited, not fired: the data router commits the URL change
         asynchronously, and the connect must not start (and publish the
         new selection) while the old conversation id is still mounted in
         the route. Inside the try so an aborted navigation takes the same
         restore path a failed connect does. */
      await navigate(routes.assistant, { replace: true });
      await switchToResolvedAssistant(assistant);
      setExpanded(false);
      requestChevronFocus();
      /* The old assistant's loader may have landed somewhere while the
         connect was in flight; sweep again so the new assistant resolves
         its own landing from a clean slate. */
      if (useConversationStore.getState().activeConversationId !== null) {
        useConversationStore.getState().setActiveConversationId(null);
        void navigate(routes.assistant, { replace: true });
      }
      onSwitched?.();
    } catch (error) {
      /* A failed connect leaves the previous assistant selected; put back
         whatever route the switch was attempted from (a conversation, the
         identity page, documents), not a conversation URL invented from the
         store id, which persists across non-chat routes. */
      if (previousConversationId !== null) {
        useConversationStore
          .getState()
          .setActiveConversationId(previousConversationId);
      }
      void navigate(previousPath, { replace: true });
      captureError(error, { context: "assistantSwitcher.switch" });
      toast.error(t("assistantSwitcher.switchFailed"));
    } finally {
      setSwitchingId(null);
      switchingIdRef.current = null;
    }
  };

  /* White at a fifth over the pill's tint (and over the card's lift), via
     currentColor so it stays legible on the light avatar hues whose pills
     flip to a dark foreground. */
  const chevronButton = (
    <button
      ref={chevronRef}
      type="button"
      onClick={() => {
        setExpanded(!expanded);
        requestChevronFocus();
      }}
      aria-expanded={expanded}
      aria-controls={expanded ? listId : undefined}
      aria-label={
        expanded
          ? t("assistantSwitcher.collapse")
          : t("assistantSwitcher.expand")
      }
      className={cn(
        /* Touch keeps the mock's 36px target; the negative margin stops it
           from growing the pill past the height its other children set. */
        "flex size-6 shrink-0 cursor-pointer items-center justify-center rounded-full max-md:-my-2 max-md:size-9",
        "bg-[color-mix(in_srgb,currentColor_20%,transparent)]",
        "[@media(hover:hover)]:hover:bg-[color-mix(in_srgb,currentColor_30%,transparent)]",
        "outline-none keyboard-focus:ring-2 keyboard-focus:ring-[var(--ring)]",
      )}
    >
      {expanded ? (
        <ChevronUp aria-hidden className="size-4" />
      ) : (
        <ChevronDown aria-hidden className="size-4" />
      )}
    </button>
  );

  const expansion = expanded ? (
    <div
      id={listId}
      className="flex flex-col rounded-[18px] bg-[var(--surface-lift)] p-[6px]"
    >
      <AssistantSwitcherRow
        assistantId={assistantId}
        name={label}
        isCurrent
        disabled={switching}
        onSelect={() => {
          setExpanded(false);
          requestChevronFocus();
        }}
        trailingAction={chevronButton}
      />
      <motion.div
        className="overflow-hidden"
        initial={reduce ? false : { height: 0, opacity: 0 }}
        animate={{ height: "auto", opacity: 1 }}
        transition={
          reduce ? { duration: 0 } : { duration: 0.2, ease: "easeOut" }
        }
      >
        <div className="flex flex-col">
          {others.map((assistant) => (
            <AssistantSwitcherRow
              key={assistant.id}
              assistantId={assistant.id}
              name={assistant.name || t("assistantSwitcher.unnamedAssistant")}
              disabled={switching}
              switching={switchingId === assistant.id}
              /* A sibling's avatar loads through ITS runtime's capability,
                 not the active assistant's: the default gate would ask a
                 pre-manifest sibling for /avatar/state it doesn't serve. */
              supportsAvatarManifest={versionSupportsAvatarStateManifest(
                assistant.runtimeVersion ?? assistant.currentReleaseVersion,
              )}
              avatarEnabled={canFetchRowAvatarViaPlatformProxy(assistant)}
              onSelect={() => void handleSwitch(assistant)}
            />
          ))}
        </div>
      </motion.div>
    </div>
  ) : null;

  return (
    <AssistantNavItem
      {...props}
      trailingAction={chevronButton}
      expansion={expansion}
    />
  );
}
