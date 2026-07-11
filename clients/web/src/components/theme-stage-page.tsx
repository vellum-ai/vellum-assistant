/**
 * Theme stage — deterministic, screenshot-friendly compositions of the app's
 * themeable surfaces, rendered inside a hidden Electron BrowserWindow and
 * captured via `webContents.capturePage()` (the `assistant ui snapshot` CLI
 * flow). Two views:
 *
 *  - `sampler`: a dense style-sheet frame (text ramp, buttons, card, inputs,
 *    borders, chat bubbles) — answers "does the palette read".
 *  - `chat`: a staged conversation with a composer facsimile — answers "does
 *    it feel like the app".
 *
 * The stage is a standalone unauthenticated route and makes no API calls:
 * workspace-theme tokens arrive URL-encoded in `?tokens=` and are applied via
 * the same `applyWorkspaceThemeTokens` fan-out the live app uses, on top of
 * the device's stored base theme (`useAppTheme`). Rendering is deterministic:
 * fixed pixel sizing, static generic copy, no images or timestamps, and all
 * transitions/animations disabled. Once fonts are loaded and two frames have
 * painted, the page sets `document.title` to the ready sentinel so the
 * capturing window knows the pixels are settled.
 *
 * The bubble markup mirrors the classNames in
 * `domains/chat/transcript/transcript-message-body.tsx` (which cannot be
 * imported here: cross-domain boundary, live-conversation stores, streaming
 * animation). If bubble styling changes there, update the stage to match.
 */

import { useEffect, useMemo } from "react";

import { useParams, useSearchParams } from "react-router";

import { Button, Card, Input, Textarea } from "@vellumai/design-library";

import { useAppTheme } from "@/hooks/use-app-theme";
import {
  applyWorkspaceThemeTokens,
  type WorkspaceThemeTokens,
} from "@/domains/settings/utils/workspace-theme-tokens";

export const THEME_STAGE_READY_TITLE = "__THEME_STAGE_READY__";

export type ThemeStageView = "sampler" | "chat";

export function parseThemeStageView(view: string | undefined): ThemeStageView {
  return view === "chat" ? "chat" : "sampler";
}

/**
 * Parses the `?tokens=` URL payload (URL-encoded JSON object of workspace
 * theme tokens). Tolerant: anything malformed renders the unthemed stage.
 */
export function parseThemeStageTokens(
  raw: string | null,
): WorkspaceThemeTokens | undefined {
  if (!raw) {
    return undefined;
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return undefined;
    }
    const tokens: Record<string, string> = {};
    for (const [key, value] of Object.entries(parsed)) {
      if (typeof value === "string") {
        tokens[key] = value;
      }
    }
    return tokens as WorkspaceThemeTokens;
  } catch {
    return undefined;
  }
}

const STAGE_WIDTH_CLASS = "w-[720px]";

function SectionLabel({ children }: { children: string }) {
  return (
    <div className="text-xs font-medium uppercase tracking-wide text-[var(--content-tertiary)]">
      {children}
    </div>
  );
}

function TextRamp() {
  return (
    <div className="flex flex-col gap-1">
      <SectionLabel>Text</SectionLabel>
      <div className="text-[15px] text-[var(--content-default)]">
        Primary text — the main reading surface of the app.
      </div>
      <div className="text-[15px] text-[var(--content-secondary)]">
        Secondary text — supporting copy and descriptions.
      </div>
      <div className="text-sm text-[var(--content-tertiary)]">
        Tertiary text — captions, labels, and placeholders.
      </div>
      <div className="text-sm text-[var(--content-quiet)]">
        Quiet text — metadata and timestamps.
      </div>
      <div className="text-sm text-[var(--content-faint)]">
        Faint text — the last legible step of the ramp.
      </div>
    </div>
  );
}

function ButtonRow() {
  return (
    <div className="flex flex-col gap-2">
      <SectionLabel>Buttons</SectionLabel>
      <div className="flex items-center gap-3">
        <Button>Primary</Button>
        <Button variant="outlined">Secondary</Button>
        <Button disabled>Disabled</Button>
      </div>
    </div>
  );
}

function AccentRow() {
  return (
    <div className="flex flex-col gap-2">
      <SectionLabel>Accent</SectionLabel>
      <div className="flex items-center gap-3">
        <div className="rounded-md bg-[var(--primary-base)] px-4 py-2 text-sm font-medium text-[var(--content-inset)]">
          Accent fill
        </div>
        <div className="rounded-md border border-[var(--border-active)] px-4 py-2 text-sm text-[var(--content-default)]">
          Active border
        </div>
        <div className="h-6 w-6 rounded-full bg-[var(--primary-hover)]" />
        <div className="h-6 w-6 rounded-full bg-[var(--primary-active)]" />
      </div>
    </div>
  );
}

function SurfacesAndBorders() {
  return (
    <div className="flex flex-col gap-2">
      <SectionLabel>Surfaces and borders</SectionLabel>
      <Card elevated>
        <div className="flex flex-col gap-2 p-4">
          <div className="text-[15px] font-medium text-[var(--content-default)]">
            Raised card
          </div>
          <div className="text-sm text-[var(--content-secondary)]">
            Elevated surfaces sit above panels and the page background.
          </div>
          <div className="border-t border-[var(--border-subtle)] pt-2 text-sm text-[var(--content-tertiary)]">
            Subtle divider above this line.
          </div>
        </div>
      </Card>
      <div className="flex items-center gap-3">
        <div className="rounded-md border border-[var(--border-base)] bg-[var(--surface-overlay)] px-3 py-2 text-sm text-[var(--content-secondary)]">
          Overlay surface
        </div>
        <div className="rounded-md border border-[var(--border-element)] bg-[var(--surface-active)] px-3 py-2 text-sm text-[var(--content-secondary)]">
          Active surface
        </div>
      </div>
    </div>
  );
}

function InputsRow() {
  return (
    <div className="flex flex-col gap-2">
      <SectionLabel>Inputs</SectionLabel>
      <Input fullWidth placeholder="A placeholder in an empty field" readOnly />
      <Textarea
        fullWidth
        readOnly
        rows={2}
        value="Text someone has already typed into a field."
      />
    </div>
  );
}

/**
 * ClassNames mirror `transcript-message-body.tsx` (user bubble + assistant
 * full-width text) so the stage recolors exactly like the live transcript.
 */
function StageUserMessage({ children }: { children: string }) {
  return (
    <div className="group/msg flex justify-end">
      <div className="flex w-full min-w-0 flex-col gap-2 items-end">
        <div className="max-w-[80%] rounded-lg bg-[var(--user-bubble-bg,var(--surface-lift))] px-4 py-3 text-[var(--user-bubble-text,var(--content-default))] flex flex-col gap-2">
          <div className="break-words text-[15px]">{children}</div>
        </div>
      </div>
    </div>
  );
}

function StageAssistantMessage({ children }: { children: string }) {
  return (
    <div className="group/msg flex justify-start">
      <div className="flex w-full min-w-0 flex-col gap-2 items-start">
        <div className="w-full text-[var(--content-default)]">
          <div className="break-words text-[15px] w-full">{children}</div>
        </div>
      </div>
    </div>
  );
}

function BubblesSection() {
  return (
    <div className="flex flex-col gap-3">
      <SectionLabel>Messages</SectionLabel>
      <StageUserMessage>
        A message from the user, in its bubble.
      </StageUserMessage>
      <StageAssistantMessage>
        A reply from the assistant, rendered full-width on the page surface.
      </StageAssistantMessage>
    </div>
  );
}

function SamplerView() {
  return (
    <div
      data-testid="theme-stage-sampler"
      className={`${STAGE_WIDTH_CLASS} flex min-h-[1080px] flex-col gap-6 bg-[var(--background)] p-8`}
    >
      <div className="text-lg font-semibold text-[var(--content-default)]">
        Theme sampler
      </div>
      <TextRamp />
      <AccentRow />
      <ButtonRow />
      <SurfacesAndBorders />
      <InputsRow />
      <BubblesSection />
    </div>
  );
}

function ChatView() {
  return (
    <div
      data-testid="theme-stage-chat"
      className={`${STAGE_WIDTH_CLASS} flex h-[760px] flex-col bg-[var(--background)]`}
    >
      <div className="flex items-center border-b border-[var(--border-base)] bg-[var(--surface-overlay)] px-5 py-3">
        <div className="text-[15px] font-medium text-[var(--content-default)]">
          New conversation
        </div>
      </div>
      <div className="flex flex-1 flex-col justify-end gap-4 overflow-hidden px-5 py-4">
        <StageUserMessage>
          Can you summarize the quarterly report before tomorrow's meeting?
        </StageUserMessage>
        <StageAssistantMessage>
          Done — the summary is ready. Revenue grew steadily, the two flagged
          risks from last quarter are resolved, and I pulled the three charts
          worth showing into a separate page.
        </StageAssistantMessage>
        <StageUserMessage>
          Perfect. Send it to the team in the morning.
        </StageUserMessage>
        <StageAssistantMessage>
          Scheduled for 9am. I'll include the charts and a one-paragraph
          version for anyone skimming on their phone.
        </StageAssistantMessage>
      </div>
      <div className="flex items-end gap-2 border-t border-[var(--border-base)] px-5 py-4">
        <div className="min-w-0 flex-1">
          <Textarea
            fullWidth
            readOnly
            rows={1}
            placeholder="Message your assistant"
          />
        </div>
        <Button>Send</Button>
      </div>
    </div>
  );
}

export function ThemeStagePage() {
  const params = useParams();
  const [searchParams] = useSearchParams();

  const view = parseThemeStageView(params.view);
  const rawTokens = searchParams.get("tokens");
  const tokens = useMemo(() => parseThemeStageTokens(rawTokens), [rawTokens]);

  // Standalone route bypasses RootLayout; bootstrap the device's base theme
  // (light/dark/velvet) so the stage matches what the user's windows show.
  useAppTheme();

  useEffect(() => {
    applyWorkspaceThemeTokens(tokens);
    return () => {
      applyWorkspaceThemeTokens(undefined);
    };
  }, [tokens]);

  // Signal readiness only after fonts have loaded and two frames have
  // painted, so the capture never races the font swap or the first paint.
  useEffect(() => {
    let cancelled = false;
    const fontsReady: Promise<unknown> =
      document.fonts?.ready ?? Promise.resolve();
    void fontsReady.then(() => {
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          if (!cancelled) {
            document.title = THEME_STAGE_READY_TITLE;
          }
        });
      });
    });
    return () => {
      cancelled = true;
    };
  }, [view, tokens]);

  return (
    <>
      {/* Freeze motion so the capture never lands mid-transition, and paint
          the document behind the stage so window-size drift never shows a
          white margin in captures. */}
      <style>{`* { transition: none !important; animation: none !important; caret-color: transparent !important; } html, body { background: var(--background); }`}</style>
      {view === "chat" ? <ChatView /> : <SamplerView />}
    </>
  );
}
