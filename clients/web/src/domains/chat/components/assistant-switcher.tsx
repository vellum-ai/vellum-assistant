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
import { useNavigate } from "react-router";

import { cn, toast } from "@vellumai/design-library";

import { switchToResolvedAssistant } from "@/assistant/switch-service";
import { useSwitchableAssistants } from "@/assistant/use-switchable-assistants";
import { AssistantNavItem } from "@/domains/chat/components/assistant-nav-item";
import { AssistantSwitcherRow } from "@/domains/chat/components/assistant-switcher-row";
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
  /** Mounts with the card open. Stories only; the app always starts closed. */
  defaultExpanded?: boolean;
}

export function AssistantSwitcher({
  defaultExpanded = false,
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

  /* A completed switch, a shrinking list, and the rail collapsing all fold
     the card away: the pill (or the rail's tile) is the only resting state.
     Skipped on mount so `defaultExpanded` survives its first render. */
  const mounted = useRef(false);
  useEffect(() => {
    if (!mounted.current) {
      mounted.current = true;
      return;
    }
    setExpanded(false);
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
    useConversationStore.getState().setActiveConversationId(null);
    void navigate(routes.assistant, { replace: true });
    try {
      await switchToResolvedAssistant(assistant);
      setExpanded(false);
      /* The old assistant's loader may have landed somewhere while the
         connect was in flight; sweep again so the new assistant resolves
         its own landing from a clean slate. */
      if (useConversationStore.getState().activeConversationId !== null) {
        useConversationStore.getState().setActiveConversationId(null);
        void navigate(routes.assistant, { replace: true });
      }
    } catch (error) {
      /* A failed connect leaves the previous assistant selected; put its
         conversation back too. */
      if (previousConversationId !== null) {
        useConversationStore
          .getState()
          .setActiveConversationId(previousConversationId);
        void navigate(routes.conversation(previousConversationId), {
          replace: true,
        });
      }
      captureError(error, { context: "assistantSwitcher.switch" });
      toast.error(t("assistantSwitcher.switchFailed"));
    } finally {
      setSwitchingId(null);
    }
  };

  /* White at a fifth over the pill's tint (and over the card's lift), via
     currentColor so it stays legible on the light avatar hues whose pills
     flip to a dark foreground. */
  const chevronButton = (
    <button
      type="button"
      onClick={() => setExpanded((value) => !value)}
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
        onSelect={() => setExpanded(false)}
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
