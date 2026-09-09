import { Database, Loader2, RotateCw } from "lucide-react";
import { useQuery } from "@tanstack/react-query";

import { useActiveAssistantId } from "@/assistant/use-active-assistant-id";
import { debugDatabaseGetOptions } from "@/generated/daemon/@tanstack/react-query.gen";
import type { DebugDatabaseGetResponse } from "@/generated/daemon/types.gen";
import { useIsOrgReady } from "@/hooks/use-is-org-ready";
import { useTranslation } from "@/i18n";
import { useSupportsDebugDatabase } from "@/lib/backwards-compat/use-supports-debug-database";
import { ApiError } from "@/utils/api-errors";
import { Button } from "@vellumai/design-library/components/button";
import { Card } from "@vellumai/design-library/components/card";
import { Notice } from "@vellumai/design-library/components/notice";
import { Tag, type TagTone } from "@vellumai/design-library/components/tag";
import { Typography } from "@vellumai/design-library/components/typography";

function isUnsupportedError(error: unknown): boolean {
  return error instanceof ApiError && error.status === 404;
}

function statusTone(state: DebugDatabaseGetResponse["state"]): TagTone {
  if (state === "ready") {
    return "positive";
  }
  if (state === "failed") {
    return "negative";
  }
  return "warning";
}

const STATUS_FALLBACK = {
  ready: "Ready",
  running: "Migrating",
  failed: "Failed",
  not_started: "Not started",
} as const;

const STATUS_KEY = {
  ready: "debugDatabasePanel.statusReady",
  running: "debugDatabasePanel.statusRunning",
  failed: "debugDatabasePanel.statusFailed",
  not_started: "debugDatabasePanel.statusNotStarted",
} as const;

export function DatabaseDebugPanel() {
  const { t } = useTranslation("settings");
  const assistantId = useActiveAssistantId();
  const orgReady = useIsOrgReady();
  const supports = useSupportsDebugDatabase();

  const query = useQuery({
    ...debugDatabaseGetOptions({ path: { assistant_id: assistantId } }),
    enabled: orgReady && supports,
  });

  const unsupported = !supports || isUnsupportedError(query.error);

  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-center gap-3">
          <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-[var(--surface-base)]">
            <Database className="h-5 w-5 text-[var(--content-secondary)]" />
          </div>
          <div>
            <h2 className="text-title-small text-[var(--content-default)]">
              {t("debugDatabasePanel.title", "Database")}
            </h2>
            <p className="text-body-medium-lighter text-[var(--content-tertiary)]">
              {t(
                "debugDatabasePanel.subtitle",
                "Migration status for this assistant, including failed and deferred steps.",
              )}
            </p>
          </div>
        </div>
        <Button
          type="button"
          variant="outlined"
          size="compact"
          leftIcon={<RotateCw />}
          onClick={() => {
            void query.refetch();
          }}
          disabled={!supports || query.isFetching}
        >
          {t("debugDatabasePanel.refresh", "Refresh")}
        </Button>
      </div>

      {unsupported ? (
        <Notice tone="info">
          {t(
            "debugDatabasePanel.unsupported",
            "This assistant version does not report database diagnostics yet.",
          )}
        </Notice>
      ) : query.isPending ? (
        <div className="flex items-center gap-2 text-body-medium-lighter text-[var(--content-tertiary)]">
          <Loader2 className="h-4 w-4 animate-spin" />
          {t("debugDatabasePanel.loading", "Loading database status…")}
        </div>
      ) : query.error ? (
        <Notice tone="error">
          {t(
            "debugDatabasePanel.loadError",
            "Could not load database diagnostics.",
          )}
        </Notice>
      ) : query.data ? (
        <DatabaseDebugBody data={query.data} />
      ) : null}
    </div>
  );
}

function DatabaseDebugBody({ data }: { data: DebugDatabaseGetResponse }) {
  const { t } = useTranslation("settings");
  const hasFailures = data.failed.length > 0;
  const hasDeferred = data.deferred.length > 0;

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <Tag tone={statusTone(data.state)}>
          {t(STATUS_KEY[data.state], STATUS_FALLBACK[data.state])}
        </Tag>
        {data.reason ? (
          <Typography variant="body-small-lighter">{data.reason}</Typography>
        ) : null}
      </div>

      {data.error ? <Notice tone="error">{data.error}</Notice> : null}

      {data.state === "running" ? (
        <Notice tone="info">
          {t(
            "debugDatabasePanel.migratingHint",
            "Migrations are still running. Failed steps will appear here if a step throws.",
          )}
        </Notice>
      ) : null}

      {data.validationError ? (
        <Notice
          tone="error"
          title={t("debugDatabasePanel.validationHeading", "Validation error")}
        >
          {data.validationError}
        </Notice>
      ) : null}

      {hasFailures ? (
        <section className="space-y-2">
          <Typography variant="title-small">
            {t("debugDatabasePanel.failedHeading", "Failed migrations")}
          </Typography>
          {data.failed.map((step) => (
            <Card key={step.name}>
              <Typography variant="body-medium-default">{step.name}</Typography>
              {step.error ? (
                <Typography
                  variant="body-small-lighter"
                  className="mt-1 font-mono"
                >
                  {step.error}
                </Typography>
              ) : null}
            </Card>
          ))}
        </section>
      ) : data.state !== "running" ? (
        <Notice tone="success">
          {t("debugDatabasePanel.noFailures", "No failed migrations.")}
        </Notice>
      ) : null}

      {hasDeferred ? (
        <section className="space-y-2">
          <Typography variant="title-small">
            {t("debugDatabasePanel.deferredHeading", "Deferred migrations")}
          </Typography>
          {data.deferred.map((step) => (
            <Card key={step.name}>
              <Typography variant="body-medium-default">{step.name}</Typography>
              <Typography variant="body-small-lighter" className="mt-1">
                {t("debugDatabasePanel.missingDeps", {
                  deps: step.missing.join(", "),
                })}
              </Typography>
            </Card>
          ))}
        </section>
      ) : null}
    </div>
  );
}
