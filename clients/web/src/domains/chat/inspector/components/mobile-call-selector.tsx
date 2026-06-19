import { ChevronDown } from "lucide-react";
import { useState, type ReactNode } from "react";

import type { LLMRequestLogEntry } from "@vellumai/assistant-api";
import { BottomSheet } from "@vellumai/design-library";

import { CallRail } from "./call-rail";

interface MobileCallSelectorProps {
  logs: LLMRequestLogEntry[];
  selectedLogId: string | undefined;
  buildCallHref: (logId: string) => string;
  /**
   * Conversation-wide call numbers keyed by log id (message-scoped
   * mode only). See `CallRail` for the numbering contract.
   */
  callNumbers?: ReadonlyMap<string, number>;
  /** Total calls in the whole conversation; pairs with `callNumbers`. */
  conversationCallCount?: number;
}

/**
 * Mobile-only trigger + bottom sheet for selecting an LLM call.
 *
 * The desktop layout keeps the rail visible as a permanent `<aside>` next
 * to the tab content. Mobile is too narrow to spare a column, so we
 * surface a full-width pill at the top of the content area that shows
 * the currently selected call and opens an overlay sheet listing every
 * call in the conversation.
 *
 * The sheet closes itself after a row is tapped via `CallRail`'s
 * `onSelect` callback — `?callId` URL changes alone don't reset the
 * sheet's local `open` state.
 */
export function MobileCallSelector({
  logs,
  selectedLogId,
  buildCallHref,
  callNumbers,
  conversationCallCount,
}: MobileCallSelectorProps): ReactNode {
  const [open, setOpen] = useState(false);

  // Identify the selected call's chronological position so the trigger
  // can show "Call N of M" — the same numbering the rail uses. `logs`
  // is ordered oldest-first; `callNumber = index + 1`. When
  // conversation-wide numbers are available (message-scoped mode), both
  // N and M use the whole-conversation numbering instead.
  const globalNumber = selectedLogId
    ? callNumbers?.get(selectedLogId)
    : undefined;
  const useGlobal = globalNumber != null && conversationCallCount != null;
  const total = useGlobal ? conversationCallCount : logs.length;
  const selectedIndex = selectedLogId
    ? logs.findIndex((l) => l.id === selectedLogId)
    : -1;
  const callNumber = useGlobal
    ? globalNumber
    : selectedIndex >= 0
      ? selectedIndex + 1
      : null;

  const triggerLabel =
    callNumber != null
      ? `Call ${callNumber} of ${total}`
      : total === 1
        ? "1 LLM call"
        : `${total} LLM calls`;

  return (
    <BottomSheet.Root open={open} onOpenChange={setOpen}>
      <BottomSheet.Trigger asChild>
        <button
          type="button"
          aria-label="Select an LLM call to inspect"
          className="flex w-full shrink-0 items-center justify-between gap-2 px-4 py-2.5 text-left"
          style={{
            background: "var(--surface-base)",
            borderBottom: "1px solid var(--border-base)",
            color: "var(--content-default)",
          }}
        >
          <span className="text-label-medium-default">{triggerLabel}</span>
          <ChevronDown
            size={16}
            aria-hidden
            style={{ color: "var(--content-secondary)" }}
          />
        </button>
      </BottomSheet.Trigger>
      <BottomSheet.Content className="max-h-[80dvh]">
        <BottomSheet.Header>
          <BottomSheet.Title>Select a call</BottomSheet.Title>
        </BottomSheet.Header>
        {/* Reset the sheet body's horizontal padding so the rail's own
            row padding (`p-3` on each `CallRow`) matches the desktop
            aside instead of double-padding on the left/right. */}
        <BottomSheet.Body className="-mx-4 px-0">
          <CallRail
            logs={logs}
            selectedLogId={selectedLogId}
            buildCallHref={buildCallHref}
            onSelect={() => setOpen(false)}
            callNumbers={callNumbers}
          />
        </BottomSheet.Body>
      </BottomSheet.Content>
    </BottomSheet.Root>
  );
}
