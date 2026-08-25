import type { TFunction } from "i18next";
import type { ReactNode } from "react";
import { useEffect, useMemo, useState } from "react";

import { Card } from "@vellumai/design-library";

import { useActiveAssistantId } from "@/assistant/use-active-assistant-id";
import { Trans, t, useTranslation } from "@/i18n";
import { useCanUseInternalThreadActions } from "@/lib/auth/internal-thread-actions";
import type {
  MemoryRouterSimulateRequest,
  MemoryRouterSimulateResponse,
  RecentTurnPair,
} from "@/domains/chat/inspector/memory-router-simulator-api";
import {
  useCurrentNowText,
  useDefaultRouterPromptTemplate,
  useLlmProfiles,
  useSimulateMemoryRouter,
} from "@/domains/chat/inspector/memory-router-simulator-api";
import { useIsSessionInitializing } from "@/stores/auth-store";
import { useClientFeatureFlagStore } from "@/stores/client-feature-flag-store";

/**
 * Developer-only page for dry-running the v4 memory router with custom
 * config overrides. Hits the daemon's read-only `simulate_memory_router`
 * route — no writes to the EMA event log or activation logs.
 *
 * Two independent result panes share one conversational context (now,
 * prior assistant reply, just-arrived user message). Each pane carries
 * its own override fields and runs its own simulation; after both have
 * run, slugs are color-coded by whether they appear in both panes or
 * only one.
 *
 * Gated by:
 *   1. The `memoryRouterPlayground` client feature flag (default off).
 *   2. The same internal-thread-actions flag gate that protects the LLM
 *      context inspector (/assistant/conversations/:conversationId/inspect).
 */
export function MemoryRouterPlaygroundPage(): ReactNode {
  const { t } = useTranslation("chat");
  const canInspect = useCanUseInternalThreadActions();
  const authLoading = useIsSessionInitializing();
  const flagEnabled = useClientFeatureFlagStore.use.memoryRouterPlayground();

  if (authLoading) {
    return (
      <CenteredMessage>{t("memoryRouterPlaygroundPage.loading")}</CenteredMessage>
    );
  }
  if (!canInspect || !flagEnabled) {
    return (
      <CenteredMessage>
        {t("memoryRouterPlaygroundPage.notAvailable")}
      </CenteredMessage>
    );
  }

  return <PlaygroundView />;
}

type PaneId = "A" | "B";

interface PaneOverrides {
  tier1: string;
  tier2: string;
  batch: string;
  /** Profile name, or empty string for "inherit active". */
  profile: string;
  /** Inline router prompt override; empty = use bundled. */
  customPrompt: string;
}

const EMPTY_OVERRIDES: PaneOverrides = {
  tier1: "",
  tier2: "",
  batch: "",
  profile: "",
  customPrompt: "",
};

function PlaygroundView(): ReactNode {
  const { t } = useTranslation("chat");
  const assistantId = useActiveAssistantId();
  const mutationA = useSimulateMemoryRouter(assistantId);
  const mutationB = useSimulateMemoryRouter(assistantId);
  const profilesQuery = useLlmProfiles(assistantId);
  const promptTemplateQuery = useDefaultRouterPromptTemplate(assistantId);
  const nowTextQuery = useCurrentNowText(assistantId);

  // Conversational context — shared between both panes so the comparison
  // is about config knobs, not about which scenario the router saw.
  // `recentTurnPairs` is rendered oldest-first; the LAST entry's
  // `userMessage` is the just-arrived turn that triggered the router.
  const [nowText, setNowText] = useState("");
  const [recentTurnPairs, setRecentTurnPairs] = useState<RecentTurnPair[]>([
    { assistantMessage: "", userMessage: "" },
  ]);
  // Track which fields the user has touched so the live NOW.md autoload
  // doesn't clobber an in-progress edit. The first time the fetch lands,
  // we seed `nowText`; after that the user owns it.
  const [nowTextDirty, setNowTextDirty] = useState(false);

  useEffect(() => {
    if (nowTextDirty) {
      return;
    }
    const fetched = nowTextQuery.data?.nowText;
    if (typeof fetched === "string" && nowText === "") {
      setNowText(fetched);
    }
  }, [nowTextQuery.data?.nowText, nowText, nowTextDirty]);

  const [overridesA, setOverridesA] = useState<PaneOverrides>(EMPTY_OVERRIDES);
  const [overridesB, setOverridesB] = useState<PaneOverrides>(EMPTY_OVERRIDES);
  const [validationA, setValidationA] = useState<string | null>(null);
  const [validationB, setValidationB] = useState<string | null>(null);

  const lastUserMessage =
    recentTurnPairs[recentTurnPairs.length - 1].userMessage;

  const runPane = (pane: PaneId) => {
    const overrides = pane === "A" ? overridesA : overridesB;
    const setValidation = pane === "A" ? setValidationA : setValidationB;
    const mutation = pane === "A" ? mutationA : mutationB;
    setValidation(null);
    let configOverrides: MemoryRouterSimulateRequest["configOverrides"];
    try {
      configOverrides = buildOverrides(overrides);
    } catch (err) {
      setValidation(
        err instanceof Error
          ? err.message
          : t("memoryRouterPlaygroundPage.invalidOverrideInput"),
      );
      return;
    }
    const profileOverride =
      overrides.profile.trim().length > 0 ? overrides.profile : undefined;
    const routerPromptOverride =
      overrides.customPrompt.trim().length > 0
        ? overrides.customPrompt
        : undefined;
    // Trim the just-arrived user message so leading/trailing whitespace
    // doesn't reach the wire; older pairs are sent verbatim so the user
    // can paste real conversation transcripts without their formatting
    // being normalized away.
    const wirePairs = recentTurnPairs.map((p, i) =>
      i === recentTurnPairs.length - 1
        ? { ...p, userMessage: p.userMessage.trim() }
        : p,
    );
    mutation.mutate({
      recentTurnPairs: wirePairs,
      nowText,
      ...(configOverrides ? { configOverrides } : {}),
      ...(profileOverride !== undefined ? { profileOverride } : {}),
      ...(routerPromptOverride !== undefined ? { routerPromptOverride } : {}),
    });
  };

  const runBoth = () => {
    runPane("A");
    runPane("B");
  };

  const userReady = lastUserMessage.trim().length > 0;
  const canRunA = userReady && !mutationA.isPending;
  const canRunB = userReady && !mutationB.isPending;

  return (
    <div className="flex h-full min-h-0 flex-col overflow-y-auto">
      <div className="mx-auto flex w-full max-w-[1280px] flex-col gap-6 p-6">
        <PageHeader />
        <ConversationContextSection
          nowText={nowText}
          onNowTextChange={(v) => {
            setNowTextDirty(true);
            setNowText(v);
          }}
          onReloadNowText={() => {
            const fetched = nowTextQuery.data?.nowText;
            if (typeof fetched === "string") {
              setNowText(fetched);
              setNowTextDirty(false);
            }
          }}
          nowTextLoading={nowTextQuery.isLoading}
          pairs={recentTurnPairs}
          onPairsChange={setRecentTurnPairs}
        />
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          <PaneConfigForm
            // eslint-disable-next-line local/no-untranslated-strings -- pane identifier, not copy
            paneId="A"
            overrides={overridesA}
            onChange={setOverridesA}
            onRun={() => runPane("A")}
            canRun={canRunA}
            isRunning={mutationA.isPending}
            profiles={profilesQuery.data?.profiles ?? []}
            activeProfile={profilesQuery.data?.activeProfile ?? null}
            defaultPromptTemplate={promptTemplateQuery.data?.template ?? ""}
          />
          <PaneConfigForm
            // eslint-disable-next-line local/no-untranslated-strings -- pane identifier, not copy
            paneId="B"
            overrides={overridesB}
            onChange={setOverridesB}
            onRun={() => runPane("B")}
            canRun={canRunB}
            isRunning={mutationB.isPending}
            profiles={profilesQuery.data?.profiles ?? []}
            activeProfile={profilesQuery.data?.activeProfile ?? null}
            defaultPromptTemplate={promptTemplateQuery.data?.template ?? ""}
          />
        </div>
        <div className="flex justify-end">
          <RunBothButton
            onClick={runBoth}
            disabled={!userReady || mutationA.isPending || mutationB.isPending}
            isRunning={mutationA.isPending || mutationB.isPending}
          />
        </div>
        <DiffLegend
          visible={mutationA.data !== undefined && mutationB.data !== undefined}
        />
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          <PaneOutputColumn
            // eslint-disable-next-line local/no-untranslated-strings -- pane identifier, not copy
            paneId="A"
            userMessage={lastUserMessage}
            mutation={mutationA}
            otherResult={mutationB.data?.response}
            validation={validationA}
          />
          <PaneOutputColumn
            // eslint-disable-next-line local/no-untranslated-strings -- pane identifier, not copy
            paneId="B"
            userMessage={lastUserMessage}
            mutation={mutationB}
            otherResult={mutationA.data?.response}
            validation={validationB}
          />
        </div>
      </div>
    </div>
  );
}

// ── Input helpers ──────────────────────────────────────────────────────────

function buildOverrides(
  overrides: PaneOverrides,
): MemoryRouterSimulateRequest["configOverrides"] {
  const merged = {
    ...maybeOverride("tier1_size", overrides.tier1),
    ...maybeOverride("tier2_size", overrides.tier2),
    ...maybeOverride("batch_size", overrides.batch),
  };
  return Object.keys(merged).length === 0 ? undefined : merged;
}

function maybeOverride(
  fieldName: string,
  raw: string,
): Record<string, number | null> {
  const trimmed = raw.trim();
  if (trimmed === "") {
    return {};
  }
  if (trimmed === "null") {
    return { [fieldName]: null };
  }
  const parsed = Number(trimmed);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(
      t("chat:memoryRouterPlaygroundPage.overrideMustBePositiveInteger", {
        fieldName,
        value: trimmed,
      }),
    );
  }
  return { [fieldName]: parsed };
}

// ── Layout components ──────────────────────────────────────────────────────

function PageHeader(): ReactNode {
  const { t } = useTranslation("chat");

  return (
    <div className="flex flex-col gap-1">
      <h1
        className="text-body-large-default"
        style={{ color: "var(--content-default)" }}
      >
        {t("memoryRouterPlaygroundPage.title")}
      </h1>
      <p
        className="text-body-medium-lighter"
        style={{ color: "var(--content-secondary)" }}
      >
        <Trans
          ns="chat"
          i18nKey="memoryRouterPlaygroundPage.description"
          components={{ code: <code /> }}
        />
      </p>
    </div>
  );
}

function ConversationContextSection({
  nowText,
  onNowTextChange,
  onReloadNowText,
  nowTextLoading,
  pairs,
  onPairsChange,
}: {
  nowText: string;
  onNowTextChange: (value: string) => void;
  onReloadNowText: () => void;
  nowTextLoading: boolean;
  pairs: RecentTurnPair[];
  onPairsChange: (next: RecentTurnPair[]) => void;
}): ReactNode {
  const { t } = useTranslation("chat");
  const updatePair = (index: number, patch: Partial<RecentTurnPair>) => {
    onPairsChange(pairs.map((p, i) => (i === index ? { ...p, ...patch } : p)));
  };
  const addOlderPair = () => {
    onPairsChange([{ assistantMessage: "", userMessage: "" }, ...pairs]);
  };
  const removePair = (index: number) => {
    // Refuse to drop the most recent pair — its `userMessage` is the
    // just-arrived turn that the router is routing for.
    if (index === pairs.length - 1) {
      return;
    }
    onPairsChange(pairs.filter((_, i) => i !== index));
  };
  return (
    <Card>
      <div className="flex flex-col gap-4 p-4">
        <span
          className="text-body-medium-default"
          style={{ color: "var(--content-default)" }}
        >
          {t("memoryRouterPlaygroundPage.conversationalContextTitle")}
        </span>
        <ContextField
          id="memory-router-playground-now"
          label={t("memoryRouterPlaygroundPage.nowBlockLabel")}
          value={nowText}
          onChange={onNowTextChange}
          rows={6}
          monospace
          placeholder={
            nowTextLoading
              ? t("memoryRouterPlaygroundPage.nowLoadingPlaceholder")
              : t("memoryRouterPlaygroundPage.nowDefaultPlaceholder")
          }
          trailing={
            <button
              type="button"
              onClick={onReloadNowText}
              disabled={nowTextLoading}
              className="rounded px-2 py-1 text-label-default"
              style={{
                background: "var(--surface-overlay)",
                color: "var(--content-secondary)",
                border: "none",
                cursor: nowTextLoading ? "not-allowed" : "pointer",
              }}
            >
              {t("memoryRouterPlaygroundPage.reloadNowButton")}
            </button>
          }
        />
        <div className="flex items-baseline justify-between">
          <span
            className="text-label-default"
            style={{ color: "var(--content-secondary)" }}
          >
            {t("memoryRouterPlaygroundPage.recentPairsLabel")}
          </span>
          <button
            type="button"
            onClick={addOlderPair}
            className="rounded px-2 py-1 text-label-default"
            style={{
              background: "var(--surface-overlay)",
              color: "var(--content-secondary)",
              border: "none",
              cursor: "pointer",
            }}
          >
            {t("memoryRouterPlaygroundPage.addOlderPairButton")}
          </button>
        </div>
        {pairs.map((pair, index) => {
          const isLast = index === pairs.length - 1;
          return (
            <div
              key={index}
              className="flex flex-col gap-2 rounded-md border p-3"
              style={{
                borderColor: "var(--border-base)",
                background: "var(--surface-base)",
              }}
            >
              <div className="flex items-baseline justify-between">
                <span
                  className="text-label-default"
                  style={{ color: "var(--content-secondary)" }}
                >
                  {t("memoryRouterPlaygroundPage.pairLabel", {
                    index: index + 1,
                    total: pairs.length,
                  })}
                  {isLast
                    ? t("memoryRouterPlaygroundPage.pairMostRecentSuffix")
                    : ""}
                </span>
                {!isLast && (
                  <button
                    type="button"
                    onClick={() => removePair(index)}
                    className="rounded px-2 py-1 text-label-default"
                    style={{
                      background: "transparent",
                      color: "var(--system-negative-strong)",
                      border: "none",
                      cursor: "pointer",
                    }}
                  >
                    {t("memoryRouterPlaygroundPage.removeButton")}
                  </button>
                )}
              </div>
              <ContextField
                id={`memory-router-playground-pair-${index}-assistant`}
                label={t("memoryRouterPlaygroundPage.assistantReplyLabel")}
                value={pair.assistantMessage}
                onChange={(v) => updatePair(index, { assistantMessage: v })}
                rows={3}
                placeholder={
                  index === 0 && pairs.length === 1
                    ? t("memoryRouterPlaygroundPage.firstTurnAssistantPlaceholder")
                    : t("memoryRouterPlaygroundPage.assistantReplyPlaceholder")
                }
              />
              <ContextField
                id={`memory-router-playground-pair-${index}-user`}
                label={
                  isLast
                    ? t("memoryRouterPlaygroundPage.justArrivedUserLabel")
                    : t("memoryRouterPlaygroundPage.userMessageLabel")
                }
                value={pair.userMessage}
                onChange={(v) => updatePair(index, { userMessage: v })}
                rows={3}
                placeholder={
                  isLast
                    ? t("memoryRouterPlaygroundPage.lastUserPlaceholder")
                    : t("memoryRouterPlaygroundPage.userMessagePlaceholder")
                }
                required={isLast}
              />
            </div>
          );
        })}
      </div>
    </Card>
  );
}

function ContextField({
  id,
  label,
  value,
  onChange,
  rows,
  placeholder,
  monospace,
  trailing,
  required,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  rows: number;
  placeholder?: string;
  monospace?: boolean;
  trailing?: ReactNode;
  required?: boolean;
}): ReactNode {
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center justify-between">
        <label
          htmlFor={id}
          className="text-label-default"
          style={{ color: "var(--content-secondary)" }}
        >
          {label}
          {required ? " *" : ""}
        </label>
        {trailing}
      </div>
      <textarea
        id={id}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        rows={rows}
        placeholder={placeholder}
        className="rounded-md border px-3 py-2 text-body-medium-default"
        style={{
          borderColor: "var(--border-base)",
          background: "var(--surface-base)",
          color: "var(--content-default)",
          resize: "vertical",
          ...(monospace
            ? {
                fontFamily:
                  "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
              }
            : {}),
        }}
      />
    </div>
  );
}

function PaneConfigForm({
  paneId,
  overrides,
  onChange,
  onRun,
  canRun,
  isRunning,
  profiles,
  activeProfile,
  defaultPromptTemplate,
}: {
  paneId: PaneId;
  overrides: PaneOverrides;
  onChange: (next: PaneOverrides) => void;
  onRun: () => void;
  canRun: boolean;
  isRunning: boolean;
  profiles: string[];
  activeProfile: string | null;
  defaultPromptTemplate: string;
}): ReactNode {
  const { t } = useTranslation("chat");

  return (
    <Card>
      <div className="flex flex-col gap-4 p-4">
        <div
          className="text-body-medium-default"
          style={{ color: paneAccentColor(paneId) }}
        >
          {t("memoryRouterPlaygroundPage.configTitle", { paneId })}
        </div>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <OverrideInput
            paneId={paneId}
            label="tier1_size"
            value={overrides.tier1}
            onChange={(v) => onChange({ ...overrides, tier1: v })}
          />
          <OverrideInput
            paneId={paneId}
            label="tier2_size"
            value={overrides.tier2}
            onChange={(v) => onChange({ ...overrides, tier2: v })}
          />
          <OverrideInput
            paneId={paneId}
            label="batch_size"
            value={overrides.batch}
            onChange={(v) => onChange({ ...overrides, batch: v })}
          />
        </div>
        <ProfileSelect
          paneId={paneId}
          value={overrides.profile}
          onChange={(v) => onChange({ ...overrides, profile: v })}
          profiles={profiles}
          activeProfile={activeProfile}
        />
        <PromptEditor
          paneId={paneId}
          value={overrides.customPrompt}
          onChange={(v) => onChange({ ...overrides, customPrompt: v })}
          defaultTemplate={defaultPromptTemplate}
        />
        <div className="flex justify-end">
          <button
            type="button"
            onClick={onRun}
            disabled={!canRun}
            className="rounded-md px-4 py-2 text-body-medium-default transition-colors"
            style={{
              background: canRun
                ? "var(--system-positive-strong)"
                : "var(--surface-overlay)",
              color: canRun
                ? "var(--content-on-positive)"
                : "var(--content-disabled)",
              border: "none",
              cursor: canRun ? "pointer" : "not-allowed",
            }}
          >
            {isRunning
              ? t("memoryRouterPlaygroundPage.running")
              : t("memoryRouterPlaygroundPage.runPane", { paneId })}
          </button>
        </div>
      </div>
    </Card>
  );
}

function PromptEditor({
  paneId,
  value,
  onChange,
  defaultTemplate,
}: {
  paneId: PaneId;
  value: string;
  onChange: (value: string) => void;
  defaultTemplate: string;
}): ReactNode {
  const { t } = useTranslation("chat");
  const [open, setOpen] = useState(false);
  const inputId = `memory-router-playground-${paneId}-prompt`;
  const usingCustom = value.trim().length > 0;
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center justify-between">
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          className="text-label-default"
          style={{
            color: "var(--content-secondary)",
            background: "transparent",
            border: "none",
            padding: 0,
            cursor: "pointer",
            textAlign: "left",
          }}
        >
          {open ? "▾" : "▸"} {t("memoryRouterPlaygroundPage.systemPrompt")}{" "}
          <span style={{ color: "var(--content-tertiary)" }}>
            (
            {usingCustom
              ? t("memoryRouterPlaygroundPage.promptModeCustom")
              : t("memoryRouterPlaygroundPage.promptModeBundled")}
            )
          </span>
        </button>
        {open && (
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => onChange(defaultTemplate)}
              disabled={defaultTemplate.length === 0}
              className="rounded px-2 py-1 text-label-default"
              style={{
                background: "var(--surface-overlay)",
                color: "var(--content-secondary)",
                border: "none",
                cursor:
                  defaultTemplate.length === 0 ? "not-allowed" : "pointer",
              }}
            >
              {t("memoryRouterPlaygroundPage.loadDefault")}
            </button>
            <button
              type="button"
              onClick={() => onChange("")}
              disabled={!usingCustom}
              className="rounded px-2 py-1 text-label-default"
              style={{
                background: "var(--surface-overlay)",
                color: "var(--content-secondary)",
                border: "none",
                cursor: usingCustom ? "pointer" : "not-allowed",
              }}
            >
              {t("memoryRouterPlaygroundPage.reset")}
            </button>
          </div>
        )}
      </div>
      {open && (
        <textarea
          id={inputId}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          rows={12}
          placeholder={t("memoryRouterPlaygroundPage.customPromptPlaceholder")}
          className="rounded-md border px-3 py-2 text-body-small-default"
          style={{
            borderColor: "var(--border-base)",
            background: "var(--surface-base)",
            color: "var(--content-default)",
            fontFamily:
              "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
            resize: "vertical",
            minHeight: "120px",
          }}
        />
      )}
    </div>
  );
}

function ProfileSelect({
  paneId,
  value,
  onChange,
  profiles,
  activeProfile,
}: {
  paneId: PaneId;
  value: string;
  onChange: (value: string) => void;
  profiles: string[];
  activeProfile: string | null;
}): ReactNode {
  const { t } = useTranslation("chat");
  const inputId = `memory-router-playground-${paneId}-profile`;
  const inheritLabel =
    activeProfile !== null && activeProfile.length > 0
      ? t("memoryRouterPlaygroundPage.inheritActiveWithProfile", {
          profile: activeProfile,
        })
      : t("memoryRouterPlaygroundPage.inheritActive");
  return (
    <div className="flex flex-col gap-1">
      <label
        htmlFor={inputId}
        className="text-label-default"
        style={{ color: "var(--content-secondary)" }}
      >
        {t("memoryRouterPlaygroundPage.llmProfilesOverride")}
      </label>
      <select
        id={inputId}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="rounded-md border px-3 py-2 text-body-medium-default"
        style={{
          borderColor: "var(--border-base)",
          background: "var(--surface-base)",
          color: "var(--content-default)",
        }}
      >
        <option value="">{inheritLabel}</option>
        {profiles.map((name) => (
          <option key={name} value={name}>
            {name}
          </option>
        ))}
      </select>
    </div>
  );
}

function OverrideInput({
  paneId,
  label,
  value,
  onChange,
}: {
  paneId: PaneId;
  label: string;
  value: string;
  onChange: (value: string) => void;
}): ReactNode {
  const { t } = useTranslation("chat");
  const inputId = `memory-router-playground-${paneId}-${label}`;
  return (
    <div className="flex flex-col gap-1">
      <label
        htmlFor={inputId}
        className="text-label-default"
        style={{ color: "var(--content-secondary)" }}
      >
        {label}
      </label>
      <input
        id={inputId}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={t("memoryRouterPlaygroundPage.inheritPlaceholder")}
        className="rounded-md border px-3 py-2 text-body-medium-default"
        style={{
          borderColor: "var(--border-base)",
          background: "var(--surface-base)",
          color: "var(--content-default)",
        }}
      />
    </div>
  );
}

function RunBothButton({
  onClick,
  disabled,
  isRunning,
}: {
  onClick: () => void;
  disabled: boolean;
  isRunning: boolean;
}): ReactNode {
  const { t } = useTranslation("chat");

  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="rounded-md px-4 py-2 text-body-medium-default transition-colors"
      style={{
        background: disabled ? "var(--surface-overlay)" : "var(--primary-base)",
        color: disabled
          ? "var(--content-disabled)"
          : "var(--content-on-primary)",
        border: "none",
        cursor: disabled ? "not-allowed" : "pointer",
      }}
    >
      {isRunning
        ? t("memoryRouterPlaygroundPage.running")
        : t("memoryRouterPlaygroundPage.runBoth")}
    </button>
  );
}

function DiffLegend({ visible }: { visible: boolean }): ReactNode {
  const { t } = useTranslation("chat");

  if (!visible) {
    return null;
  }
  return (
    <div
      className="flex flex-wrap items-center gap-4 rounded-md px-4 py-2 text-label-default"
      style={{
        background: "var(--surface-overlay)",
        color: "var(--content-secondary)",
      }}
    >
      <LegendItem
        marker="●"
        markerColor="var(--content-default)"
        label={t("memoryRouterPlaygroundPage.legendInBoth")}
      />
      <LegendItem
        marker="◆"
        markerColor={paneAccentColor("A")}
        label={t("memoryRouterPlaygroundPage.legendAOnly")}
      />
      <LegendItem
        marker="◇"
        markerColor={paneAccentColor("B")}
        label={t("memoryRouterPlaygroundPage.legendBOnly")}
      />
    </div>
  );
}

function LegendItem({
  marker,
  markerColor,
  label,
}: {
  marker: string;
  markerColor: string;
  label: string;
}): ReactNode {
  return (
    <span className="flex items-center gap-1">
      <span style={{ color: markerColor }}>{marker}</span>
      <span>{label}</span>
    </span>
  );
}

// ── Result rendering ───────────────────────────────────────────────────────

type SlugDiff = "both" | "only-here";

function PaneOutputColumn({
  paneId,
  userMessage,
  mutation,
  otherResult,
  validation,
}: {
  paneId: PaneId;
  userMessage: string;
  mutation: ReturnType<typeof useSimulateMemoryRouter>;
  otherResult: MemoryRouterSimulateResponse | undefined;
  validation: string | null;
}): ReactNode {
  const { t } = useTranslation("chat");
  const data = mutation.data;
  return (
    <div className="flex flex-col gap-3">
      <PaneHeader paneId={paneId} />
      {validation !== null && <ErrorBanner message={validation} />}
      {mutation.isError && (
        <ErrorBanner
          message={
            mutation.error instanceof Error
              ? mutation.error.message
              : t("memoryRouterPlaygroundPage.failedToRunSimulation")
          }
        />
      )}
      {data !== undefined && (
        <>
          <ResultPanel
            paneId={paneId}
            userMessage={userMessage}
            result={data.response}
            otherResult={otherResult}
          />
          <RawExchangePanel
            paneId={paneId}
            rawRequest={data.rawRequest}
            rawResponse={data.rawResponse}
          />
        </>
      )}
    </div>
  );
}

function RawExchangePanel({
  paneId,
  rawRequest,
  rawResponse,
}: {
  paneId: PaneId;
  rawRequest: string;
  rawResponse: string;
}): ReactNode {
  const { t } = useTranslation("chat");
  const [open, setOpen] = useState(false);
  return (
    <Card>
      <div className="flex flex-col gap-2 p-4">
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          className="text-label-default"
          style={{
            color: "var(--content-secondary)",
            background: "transparent",
            border: "none",
            padding: 0,
            cursor: "pointer",
            textAlign: "left",
          }}
        >
          {open ? "▾" : "▸"} {t("memoryRouterPlaygroundPage.rawApiExchange")}
        </button>
        {open && (
          <div className="flex flex-col gap-3">
            <RawExchangeBlock
              label={t("memoryRouterPlaygroundPage.requestLabel", { paneId })}
              body={rawRequest}
            />
            <RawExchangeBlock
              label={t("memoryRouterPlaygroundPage.responseLabel", { paneId })}
              body={rawResponse}
            />
          </div>
        )}
      </div>
    </Card>
  );
}

function RawExchangeBlock({
  label,
  body,
}: {
  label: string;
  body: string;
}): ReactNode {
  const { t } = useTranslation("chat");

  return (
    <div className="flex flex-col gap-1">
      <span
        className="text-label-default"
        style={{ color: "var(--content-secondary)" }}
      >
        {label}
      </span>
      <pre
        className="overflow-auto rounded-md border px-3 py-2 text-body-small-default"
        style={{
          borderColor: "var(--border-base)",
          background: "var(--surface-base)",
          color: "var(--content-default)",
          fontFamily:
            "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
          maxHeight: "320px",
          whiteSpace: "pre",
        }}
      >
        {body.length === 0 ? t("memoryRouterPlaygroundPage.empty") : body}
      </pre>
    </div>
  );
}

function PaneHeader({ paneId }: { paneId: PaneId }): ReactNode {
  const { t } = useTranslation("chat");

  return (
    <div
      className="text-body-medium-default"
      style={{ color: paneAccentColor(paneId) }}
    >
      {t("memoryRouterPlaygroundPage.paneTitle", { paneId })}
    </div>
  );
}

function ResultPanel({
  paneId,
  userMessage,
  result,
  otherResult,
}: {
  paneId: PaneId;
  userMessage: string;
  result: MemoryRouterSimulateResponse;
  otherResult: MemoryRouterSimulateResponse | undefined;
}): ReactNode {
  const { t } = useTranslation("chat");
  const diff = useMemo(
    () => classifySlugs(result, otherResult),
    [result, otherResult],
  );
  const groups = useMemo(() => groupSlugsBySource(result), [result]);
  const counts = useMemo(() => countDiff(diff), [diff]);
  return (
    <div className="flex flex-col gap-4">
      <SummaryCard
        result={result}
        userMessage={userMessage}
        otherResult={otherResult}
        counts={counts}
      />
      <ConfigCard result={result} />
      {result.failureReason !== null && (
        <ErrorBanner
          message={t("memoryRouterPlaygroundPage.routerFailure", {
            reason: result.failureReason,
          })}
        />
      )}
      {groups.length === 0 ? (
        <EmptyResultCard />
      ) : (
        groups.map((group) => (
          <TierSectionCard
            key={group.source}
            paneId={paneId}
            source={group.source}
            slugs={group.slugs}
            scores={result.scores}
            diff={diff}
          />
        ))
      )}
    </div>
  );
}

function classifySlugs(
  own: MemoryRouterSimulateResponse,
  other: MemoryRouterSimulateResponse | undefined,
): Map<string, SlugDiff> {
  const out = new Map<string, SlugDiff>();
  if (other === undefined) {
    for (const slug of own.selectedSlugs) {
      out.set(slug, "both");
    }
    return out;
  }
  const otherSet = new Set(other.selectedSlugs);
  for (const slug of own.selectedSlugs) {
    out.set(slug, otherSet.has(slug) ? "both" : "only-here");
  }
  return out;
}

interface DiffCounts {
  total: number;
  shared: number;
  unique: number;
}

function countDiff(diff: Map<string, SlugDiff>): DiffCounts {
  let shared = 0;
  let unique = 0;
  for (const cls of diff.values()) {
    if (cls === "both") {
      shared++;
    } else {
      unique++;
    }
  }
  return { total: diff.size, shared, unique };
}

function SummaryCard({
  result,
  userMessage,
  otherResult,
  counts,
}: {
  result: MemoryRouterSimulateResponse;
  userMessage: string;
  otherResult: MemoryRouterSimulateResponse | undefined;
  counts: DiffCounts;
}): ReactNode {
  const { t } = useTranslation("chat");
  const rows: Array<{ label: string; value: string }> = [
    {
      label: t("memoryRouterPlaygroundPage.summaryUserMessageLabel"),
      value: userMessage,
    },
    {
      label: t("memoryRouterPlaygroundPage.totalCandidatePagesLabel"),
      value: result.totalCandidatePages.toLocaleString(),
    },
    {
      label: t("memoryRouterPlaygroundPage.selectedLabel"),
      value: t("memoryRouterPlaygroundPage.selectedValue", {
        count: result.selectedSlugs.length,
        maxPageIds: result.effectiveConfig.max_page_ids,
      }),
    },
  ];
  if (otherResult !== undefined) {
    rows.push({
      label: t("memoryRouterPlaygroundPage.diffLabel"),
      value: t("memoryRouterPlaygroundPage.diffValue", {
        shared: counts.shared,
        unique: counts.unique,
      }),
    });
  }
  return (
    <Card>
      <div className="flex flex-col gap-3 p-4">
        <span
          className="text-body-medium-default"
          style={{ color: "var(--content-default)" }}
        >
          {t("memoryRouterPlaygroundPage.summary")}
        </span>
        <MetaGrid rows={rows} />
      </div>
    </Card>
  );
}

function ConfigCard({
  result,
}: {
  result: MemoryRouterSimulateResponse;
}): ReactNode {
  const { t } = useTranslation("chat");
  const knobs: Array<keyof MemoryRouterSimulateResponse["effectiveConfig"]> = [
    "tier1_size",
    "tier2_size",
    "batch_size",
    "max_page_ids",
  ];
  const rows: Array<{ label: string; value: string }> = knobs.map((key) => {
    const eff = result.effectiveConfig[key];
    const overrideValue = (
      result.overrides as Record<string, number | null | undefined>
    )[key];
    const effStr =
      eff === null
        ? t("memoryRouterPlaygroundPage.nullValue")
        : String(eff);
    const suffix =
      overrideValue !== undefined
        ? t("memoryRouterPlaygroundPage.overrideSuffix")
        : "";
    return { label: key, value: `${effStr}${suffix}` };
  });
  rows.push({
    label: t("memoryRouterPlaygroundPage.llmProfilesOverride"),
    value:
      result.profileOverride !== null
        ? `${result.profileOverride}${t("memoryRouterPlaygroundPage.overrideSuffix")}`
        : t("memoryRouterPlaygroundPage.inheritActive"),
  });
  rows.push({
    label: t("memoryRouterPlaygroundPage.systemPromptConfigLabel"),
    value: result.routerPromptOverridden
      ? t("memoryRouterPlaygroundPage.promptModeCustom")
      : t("memoryRouterPlaygroundPage.promptModeBundled"),
  });
  return (
    <Card>
      <div className="flex flex-col gap-3 p-4">
        <span
          className="text-body-medium-default"
          style={{ color: "var(--content-default)" }}
        >
          {t("memoryRouterPlaygroundPage.effectiveConfig")}
        </span>
        <MetaGrid rows={rows} />
      </div>
    </Card>
  );
}

interface SourceGroup {
  source: string;
  slugs: string[];
}

function groupSlugsBySource(
  result: MemoryRouterSimulateResponse,
): SourceGroup[] {
  const byKey = new Map<string, string[]>();
  for (const slug of result.selectedSlugs) {
    const source = result.sourceBySlug[slug];
    if (source === undefined) {
      continue;
    }
    const bucket = byKey.get(source) ?? [];
    bucket.push(slug);
    byKey.set(source, bucket);
  }
  const sorted = [...byKey.keys()].sort(
    (a, b) => sourceOrder(a) - sourceOrder(b),
  );
  return sorted.map((source) => ({
    source,
    slugs: byKey.get(source)!,
  }));
}

function sourceOrder(source: string): number {
  if (source === "tier1") {
    return 0;
  }
  if (source === "tier2") {
    return 1;
  }
  if (source.startsWith("tier3:")) {
    return 2 + Number(source.slice("tier3:".length));
  }
  return Number.MAX_SAFE_INTEGER;
}

function formatSourceLabel(source: string, t: TFunction<"chat">): string {
  if (source === "tier1") {
    return t("memoryRouterPlaygroundPage.tier1Label");
  }
  if (source === "tier2") {
    return t("memoryRouterPlaygroundPage.tier2Label");
  }
  if (source.startsWith("tier3:")) {
    return t("memoryRouterPlaygroundPage.tier3Label", {
      batch: source.slice("tier3:".length),
    });
  }
  return source;
}

function paneAccentColor(paneId: PaneId): string {
  return paneId === "A" ? "var(--system-mid-strong)" : "var(--primary-base)";
}

function slugStyle(
  paneId: PaneId,
  diff: SlugDiff,
): { color: string; marker: string } {
  if (diff === "both") {
    return { color: "var(--content-default)", marker: "●" };
  }
  return {
    color: paneAccentColor(paneId),
    marker: paneId === "A" ? "◆" : "◇",
  };
}

function TierSectionCard({
  paneId,
  source,
  slugs,
  scores,
  diff,
}: {
  paneId: PaneId;
  source: string;
  slugs: string[];
  scores: Record<string, number>;
  diff: Map<string, SlugDiff>;
}): ReactNode {
  const { t } = useTranslation("chat");

  return (
    <Card>
      <div className="flex flex-col gap-3 p-4">
        <div className="flex items-baseline justify-between">
          <span
            className="text-body-medium-default"
            style={{ color: "var(--content-default)" }}
          >
            {formatSourceLabel(source, t)}
          </span>
          <span
            className="text-label-default"
            style={{ color: "var(--content-secondary)" }}
          >
            {t("memoryRouterPlaygroundPage.pageCount", { count: slugs.length })}
          </span>
        </div>
        <ul className="flex flex-col gap-1">
          {slugs.map((slug) => {
            const slugClass = diff.get(slug) ?? "only-here";
            const { color, marker } = slugStyle(paneId, slugClass);
            return (
              <li
                key={slug}
                className="flex items-baseline justify-between gap-3"
              >
                <span className="flex items-baseline gap-2">
                  <span style={{ color }}>{marker}</span>
                  <code className="text-body-medium-default" style={{ color }}>
                    {slug}
                  </code>
                </span>
                {source === "tier2" && (
                  <span
                    className="tabular-nums text-label-default"
                    style={{ color: "var(--content-secondary)" }}
                  >
                    {t("memoryRouterPlaygroundPage.emaScore", {
                      score: (scores[slug] ?? 0).toFixed(3),
                    })}
                  </span>
                )}
              </li>
            );
          })}
        </ul>
      </div>
    </Card>
  );
}

function EmptyResultCard(): ReactNode {
  const { t } = useTranslation("chat");

  return (
    <Card>
      <div className="flex flex-col gap-2 p-4">
        <span
          className="text-body-medium-default"
          style={{ color: "var(--content-default)" }}
        >
          {t("memoryRouterPlaygroundPage.noPagesSelected")}
        </span>
        <span
          className="text-label-default"
          style={{ color: "var(--content-secondary)" }}
        >
          {t("memoryRouterPlaygroundPage.emptySelectionHint")}
        </span>
      </div>
    </Card>
  );
}

function MetaGrid({
  rows,
}: {
  rows: { label: string; value: string }[];
}): ReactNode {
  return (
    <div className="flex flex-col gap-2">
      {rows.map(({ label, value }) => (
        <div key={label} className="flex items-baseline justify-between gap-3">
          <span
            className="shrink-0 text-label-default"
            style={{ color: "var(--content-secondary)" }}
          >
            {label}
          </span>
          <span
            className="text-right text-body-medium-lighter"
            style={{ color: "var(--content-default)" }}
          >
            {value}
          </span>
        </div>
      ))}
    </div>
  );
}

function ErrorBanner({ message }: { message: string }): ReactNode {
  return (
    <div
      className="rounded-md px-4 py-3 text-body-medium-default"
      style={{
        background: "var(--surface-overlay)",
        color: "var(--system-negative-strong)",
      }}
    >
      {message}
    </div>
  );
}

function CenteredMessage({ children }: { children: ReactNode }): ReactNode {
  return (
    <div
      className="flex h-full w-full items-center justify-center p-8 text-label-default"
      style={{ color: "var(--content-tertiary)" }}
    >
      {children}
    </div>
  );
}
