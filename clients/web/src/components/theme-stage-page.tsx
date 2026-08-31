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
import { useTranslation } from "@/i18n";
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
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      Array.isArray(parsed)
    ) {
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
  const { t } = useTranslation();
  return (
    <div className="flex flex-col gap-1">
      <SectionLabel>{t("themeStagePage.sectionText")}</SectionLabel>
      <div className="text-[15px] text-[var(--content-default)]">
        {t("themeStagePage.primaryText")}
      </div>
      <div className="text-[15px] text-[var(--content-secondary)]">
        {t("themeStagePage.secondaryText")}
      </div>
      <div className="text-sm text-[var(--content-tertiary)]">
        {t("themeStagePage.tertiaryText")}
      </div>
      <div className="text-sm text-[var(--content-quiet)]">
        {t("themeStagePage.quietText")}
      </div>
      <div className="text-sm text-[var(--content-faint)]">
        {t("themeStagePage.faintText")}
      </div>
    </div>
  );
}

function ButtonRow() {
  const { t } = useTranslation();
  return (
    <div className="flex flex-col gap-2">
      <SectionLabel>{t("themeStagePage.sectionButtons")}</SectionLabel>
      <div className="flex items-center gap-3">
        <Button>{t("themeStagePage.buttonPrimary")}</Button>
        <Button variant="outlined">{t("themeStagePage.buttonSecondary")}</Button>
        <Button disabled>{t("themeStagePage.buttonDisabled")}</Button>
      </div>
    </div>
  );
}

function AccentRow() {
  const { t } = useTranslation();
  return (
    <div className="flex flex-col gap-2">
      <SectionLabel>{t("themeStagePage.sectionAccent")}</SectionLabel>
      <div className="flex items-center gap-3">
        <div className="rounded-md bg-[var(--primary-base)] px-4 py-2 text-sm font-medium text-[var(--content-inset)]">
          {t("themeStagePage.accentFill")}
        </div>
        <div className="rounded-md border border-[var(--border-active)] px-4 py-2 text-sm text-[var(--content-default)]">
          {t("themeStagePage.activeBorder")}
        </div>
        <div className="h-6 w-6 rounded-full bg-[var(--primary-hover)]" />
        <div className="h-6 w-6 rounded-full bg-[var(--primary-active)]" />
      </div>
    </div>
  );
}

function SurfacesAndBorders() {
  const { t } = useTranslation();
  return (
    <div className="flex flex-col gap-2">
      <SectionLabel>{t("themeStagePage.sectionSurfaces")}</SectionLabel>
      <Card elevated>
        <div className="flex flex-col gap-2 p-4">
          <div className="text-[15px] font-medium text-[var(--content-default)]">
            {t("themeStagePage.raisedCard")}
          </div>
          <div className="text-sm text-[var(--content-secondary)]">
            {t("themeStagePage.raisedCardBody")}
          </div>
          <div className="border-t border-[var(--border-subtle)] pt-2 text-sm text-[var(--content-tertiary)]">
            {t("themeStagePage.subtleDivider")}
          </div>
        </div>
      </Card>
      <div className="flex items-center gap-3">
        <div className="rounded-md border border-[var(--border-base)] bg-[var(--surface-overlay)] px-3 py-2 text-sm text-[var(--content-secondary)]">
          {t("themeStagePage.overlaySurface")}
        </div>
        <div className="rounded-md border border-[var(--border-element)] bg-[var(--surface-active)] px-3 py-2 text-sm text-[var(--content-secondary)]">
          {t("themeStagePage.activeSurface")}
        </div>
      </div>
    </div>
  );
}

function InputsRow() {
  const { t } = useTranslation();
  return (
    <div className="flex flex-col gap-2">
      <SectionLabel>{t("themeStagePage.sectionInputs")}</SectionLabel>
      <Input
        fullWidth
        placeholder={t("themeStagePage.inputPlaceholder")}
        readOnly
      />
      <Textarea
        fullWidth
        readOnly
        rows={2}
        value={t("themeStagePage.inputFilled")}
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
  const { t } = useTranslation();
  return (
    <div className="flex flex-col gap-3">
      <SectionLabel>{t("themeStagePage.sectionMessages")}</SectionLabel>
      <StageUserMessage>{t("themeStagePage.userBubble")}</StageUserMessage>
      <StageAssistantMessage>
        {t("themeStagePage.assistantBubble")}
      </StageAssistantMessage>
    </div>
  );
}

function SamplerView() {
  const { t } = useTranslation();
  return (
    <div
      data-testid="theme-stage-sampler"
      className={`${STAGE_WIDTH_CLASS} flex min-h-[1080px] flex-col gap-6 bg-[var(--background)] p-8`}
    >
      <div className="text-lg font-semibold text-[var(--content-default)]">
        {t("themeStagePage.samplerTitle")}
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
  const { t } = useTranslation();
  return (
    <div
      data-testid="theme-stage-chat"
      className={`${STAGE_WIDTH_CLASS} flex h-[760px] flex-col bg-[var(--background)]`}
    >
      <div className="flex items-center border-b border-[var(--border-base)] bg-[var(--surface-overlay)] px-5 py-3">
        <div className="text-[15px] font-medium text-[var(--content-default)]">
          {t("themeStagePage.newConversation")}
        </div>
      </div>
      <div className="flex flex-1 flex-col justify-end gap-4 overflow-hidden px-5 py-4">
        <StageUserMessage>{t("themeStagePage.chatUser1")}</StageUserMessage>
        <StageAssistantMessage>
          {t("themeStagePage.chatAssistant1")}
        </StageAssistantMessage>
        <StageUserMessage>{t("themeStagePage.chatUser2")}</StageUserMessage>
        <StageAssistantMessage>
          {t("themeStagePage.chatAssistant2")}
        </StageAssistantMessage>
      </div>
      <div className="flex items-end gap-2 border-t border-[var(--border-base)] px-5 py-4">
        <div className="min-w-0 flex-1">
          <Textarea
            fullWidth
            readOnly
            rows={1}
            placeholder={t("themeStagePage.composerPlaceholder")}
          />
        </div>
        <Button>{t("themeStagePage.send")}</Button>
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
  // De-arm first: on a view/tokens change the previous ready sentinel must
  // not be observable while the new composition is still painting.
  useEffect(() => {
    let cancelled = false;
    document.title = "theme-stage";
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
      {/* eslint-disable-next-line local/no-untranslated-strings -- CSS rules, not user-facing copy */}
      <style>{`* { transition: none !important; animation: none !important; caret-color: transparent !important; } html, body { background: var(--background); }`}</style>
      {view === "chat" ? <ChatView /> : <SamplerView />}
    </>
  );
}
