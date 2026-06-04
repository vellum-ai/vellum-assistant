import { useQuery } from "@tanstack/react-query";
import { AlertTriangle, Clock, Inbox, Loader2, Send } from "lucide-react";
import { type ReactNode } from "react";
import { Link } from "react-router";

import { Tag } from "@vellumai/design-library";

import {
    assistantsEmailAddressesListOptions,
    assistantsEmailAddressesStatusRetrieveOptions,
    assistantsEmailsListOptions,
} from "@/generated/api/@tanstack/react-query.gen";
import type {
    EmailAddressUsage,
    EmailMessage,
} from "@/generated/api/types.gen";
import type { PlatformGateState } from "@/hooks/use-platform-gate";
import { routes } from "@/utils/routes";

function formatTimestamp(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="space-y-3">
      <h2
        className="text-title-small"
        style={{ color: "var(--content-default)" }}
      >
        {title}
      </h2>
      {children}
    </div>
  );
}

interface MessageBoxProps {
  tone?: "info" | "error";
  children: ReactNode;
}

function MessageBox({ tone = "info", children }: MessageBoxProps) {
  const isError = tone === "error";
  return (
    <div
      className="rounded-md border px-4 py-3 text-body-medium-lighter"
      style={{
        background: isError
          ? "var(--surface-negative-subtle, var(--surface-lift))"
          : "var(--surface-lift)",
        borderColor: isError
          ? "var(--border-negative, var(--border-base))"
          : "var(--border-base)",
        color: isError
          ? "var(--content-negative, var(--content-default))"
          : "var(--content-default)",
      }}
    >
      <div className="flex items-start gap-2">
        {isError && (
          <AlertTriangle
            className="mt-0.5 h-4 w-4 shrink-0"
            aria-hidden="true"
          />
        )}
        <div className="flex-1">{children}</div>
      </div>
    </div>
  );
}

function ErrorRetryRow({
  message,
  onRetry,
  retrying,
}: {
  message: string;
  onRetry: () => void;
  retrying: boolean;
}) {
  return (
    <MessageBox tone="error">
      <div className="flex items-center justify-between gap-3">
        <span>{message}</span>
        <button
          type="button"
          onClick={onRetry}
          disabled={retrying}
          className="text-body-small-default underline disabled:opacity-50"
          style={{ color: "var(--content-default)" }}
        >
          {retrying ? "Retrying…" : "Retry"}
        </button>
      </div>
    </MessageBox>
  );
}

interface StatTileProps {
  label: string;
  value: number | undefined;
  sub?: string;
}

function StatTile({ label, value, sub }: StatTileProps) {
  return (
    <div
      className="rounded-xl border p-3"
      style={{
        background: "var(--surface-lift)",
        borderColor: "var(--border-base)",
      }}
    >
      <p
        className="text-body-small-default"
        style={{ color: "var(--content-tertiary)" }}
      >
        {label}
      </p>
      <p
        className="mt-1 text-title-large tabular-nums"
        style={{ color: "var(--content-default)" }}
      >
        {value ?? "—"}
      </p>
      {sub && (
        <p
          className="text-body-small-default"
          style={{ color: "var(--content-disabled)" }}
        >
          {sub}
        </p>
      )}
    </div>
  );
}

function EmailRow({ email }: { email: EmailMessage }) {
  const isInbound = email.direction === "inbound";
  return (
    <div
      className="rounded-xl border p-4"
      style={{
        background: "var(--surface-lift)",
        borderColor: "var(--border-base)",
      }}
    >
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0 flex-1 space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <Tag
              tone={isInbound ? "positive" : "neutral"}
              leftIcon={isInbound ? <Inbox /> : <Send />}
            >
              {isInbound ? "Inbound" : "Outbound"}
            </Tag>
            <span
              className="truncate text-body-small-default"
              style={{ color: "var(--content-tertiary)" }}
            >
              {email.from_address}
            </span>
          </div>
          <p
            className="truncate text-body-medium-default"
            style={{ color: "var(--content-default)" }}
          >
            {email.subject || "(no subject)"}
          </p>
        </div>
        <div
          className="flex shrink-0 items-center gap-1.5 text-body-small-default"
          style={{ color: "var(--content-tertiary)" }}
        >
          <Clock className="h-3 w-3" />
          <span>{formatTimestamp(email.created_at)}</span>
        </div>
      </div>
    </div>
  );
}

interface EmailsTabProps {
  assistantId: string;
  platformGate: PlatformGateState;
}

export function EmailsTab({ assistantId, platformGate }: EmailsTabProps) {
  const gateEnabled = platformGate === "full";

  const addressesQuery = useQuery({
    ...assistantsEmailAddressesListOptions({
      path: { assistant_id: assistantId },
    }),
    enabled: gateEnabled,
  });
  const address = addressesQuery.data?.results?.[0];

  const statusQuery = useQuery({
    ...assistantsEmailAddressesStatusRetrieveOptions({
      path: { assistant_id: assistantId, id: address?.id ?? "" },
    }),
    enabled: gateEnabled && !!address?.id,
  });

  const emailsQuery = useQuery({
    ...assistantsEmailsListOptions({
      path: { assistant_id: assistantId },
      query: { limit: 10 },
    }),
    enabled: gateEnabled,
  });

  const usage: EmailAddressUsage | undefined = statusQuery.data?.usage;
  const emails: EmailMessage[] = emailsQuery.data?.results ?? [];

  if (addressesQuery.isLoading) {
    return (
      <div className="flex items-center justify-center py-24">
        <Loader2
          className="h-8 w-8 animate-spin"
          style={{ color: "var(--content-tertiary)" }}
        />
      </div>
    );
  }

  if (addressesQuery.isError) {
    return (
      <ErrorRetryRow
        message="Couldn't load email addresses."
        onRetry={() => {
          void addressesQuery.refetch();
        }}
        retrying={addressesQuery.isFetching}
      />
    );
  }

  if (!address) {
    return (
      <MessageBox>
        No email address registered yet.{" "}
        <Link
          to={routes.settings.ai}
          className="underline"
          style={{ color: "var(--content-tertiary)" }}
        >
          Set one up in AI Settings → Email.
        </Link>
      </MessageBox>
    );
  }

  return (
    <div className="flex flex-col gap-6">
      <Section title="Totals">
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <StatTile
            label="Sent today"
            value={usage?.sent_today}
            sub={usage ? `of ${usage.daily_limit} daily limit` : undefined}
          />
          <StatTile label="Received today" value={usage?.received_today} />
          <StatTile label="Sent this month" value={usage?.sent_this_month} />
          <StatTile
            label="Received this month"
            value={usage?.received_this_month}
          />
        </div>
      </Section>

      <Section title="Recent Emails">
        {emailsQuery.isLoading ? (
          <div
            className="flex items-center gap-2 text-body-small-default"
            style={{ color: "var(--content-tertiary)" }}
          >
            <Loader2 className="h-4 w-4 animate-spin" />
            Loading…
          </div>
        ) : emailsQuery.isError ? (
          <ErrorRetryRow
            message="Couldn't load recent emails."
            onRetry={() => {
              void emailsQuery.refetch();
            }}
            retrying={emailsQuery.isFetching}
          />
        ) : emails.length === 0 ? (
          <MessageBox>No emails yet.</MessageBox>
        ) : (
          <div className="space-y-2">
            {emails.map((email) => (
              <EmailRow key={email.id} email={email} />
            ))}
          </div>
        )}
      </Section>
    </div>
  );
}
