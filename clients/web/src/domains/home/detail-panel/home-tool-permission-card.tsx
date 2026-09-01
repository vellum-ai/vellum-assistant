import { useTranslation } from "@/i18n";
import { formatRelativeDate } from "@/utils/format-date";
import type { FeedItem } from "@vellumai/assistant-api";
import { Typography } from "@vellumai/design-library";

import { SUMMARY_BLOCK_CLASS } from "./detail-panel-styles";

type CredentialStatus =
  | "revoked"
  | "expired"
  | "missing_scopes"
  | "missing_token"
  | "ping_failed"
  | "unreachable";

function statusDotColor(status: string): string {
  switch (status as CredentialStatus) {
    case "revoked":
    case "expired":
      return "var(--system-negative-strong)";
    case "missing_scopes":
    case "missing_token":
    case "ping_failed":
      return "var(--system-mid-strong)";
    case "unreachable":
    default:
      return "var(--content-disabled)";
  }
}

/**
 * Catalog key naming a credential status, in the same shape as
 * `statusDotColor`. Written out per status rather than composed from the wire
 * value so the catalog can keep its camelCase key naming, and so every key
 * stays greppable for the orphan check in `catalogs.test.ts`. Null for a
 * status this build has no copy for.
 */
function statusLabelKey(status: string) {
  switch (status as CredentialStatus) {
    case "revoked":
      return "homeToolPermissionCard.status.revoked";
    case "expired":
      return "homeToolPermissionCard.status.expired";
    case "missing_scopes":
      return "homeToolPermissionCard.status.missingScopes";
    case "missing_token":
      return "homeToolPermissionCard.status.missingToken";
    case "ping_failed":
      return "homeToolPermissionCard.status.pingFailed";
    case "unreachable":
      return "homeToolPermissionCard.status.unreachable";
    default:
      return null;
  }
}

/**
 * Last resort for a status this build has no copy for. The daemon is free to
 * add statuses, and naming the one it actually reported tells the user more
 * than any of the six known labels would.
 */
function capitalizeStatus(status: string): string {
  return status
    .split("_")
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

export interface HomeToolPermissionCardProps {
  item: FeedItem;
}

export function HomeToolPermissionCard({ item }: HomeToolPermissionCardProps) {
  const { t } = useTranslation("home");
  const metadata = item.metadata;
  const provider = metadata?.provider as string | undefined;

  if (!provider) {
    // The panel header above this card already renders the title, so this
    // fallback shows the body. Matches HomeGenericDetail.
    return (
      <Typography
        variant="body-medium-default"
        className="text-[var(--content-secondary)]"
      >
        {item.summary}
      </Typography>
    );
  }

  // The producer names the credential when its provider id would not read as
  // one to a person (the Vellum-managed inference credential, whose id is the
  // vendor). Falls back to the id, which is the product name for every OAuth
  // connection.
  const providerLabel = (metadata?.providerLabel as string) || provider;
  const accountInfo = (metadata?.accountInfo as string) ?? null;
  const status = (metadata?.status as string) ?? "unreachable";
  const statusKey = statusLabelKey(status);
  const details = (metadata?.details as string) ?? "";
  const missingScopes = Array.isArray(metadata?.missingScopes)
    ? (metadata.missingScopes as string[])
    : [];

  // The panel header already names the notification, so the credential is
  // identified on the meta line rather than in a heading of its own. A second
  // title under the first reads as two headers for one thing, which is why the
  // guardian card renders none either.
  const metaLine = [
    providerLabel,
    accountInfo,
    formatRelativeDate(item.timestamp),
  ]
    .filter((part): part is string => Boolean(part))
    .join(" · ");

  return (
    <div className="flex flex-col gap-[var(--app-spacing-md)]">
      <Typography
        variant="body-small-default"
        className="text-[var(--content-tertiary)]"
      >
        {metaLine}
      </Typography>

      {/*
        The raw health status is what an OAuth connection's fix turns on:
        "Missing scopes" and "Revoked" send the reader to different places. An
        item carrying a remediation has one button that covers every one of
        them, so the status label stops being the actionable thing and starts
        being jargon. It also reads as blame for a credential the user never
        connected: nothing was taken away from them.
      */}
      {item.remediation ? null : (
        <div className="flex items-center gap-[var(--app-spacing-sm)]">
          <span
            className="inline-block shrink-0 rounded-full"
            style={{
              width: 8,
              height: 8,
              backgroundColor: statusDotColor(status),
            }}
            aria-hidden="true"
          />
          <Typography
            variant="body-medium-default"
            className="text-[var(--content-default)]"
          >
            {statusKey ? t(statusKey) : capitalizeStatus(status)}
          </Typography>
        </div>
      )}

      {details ? (
        <Typography
          variant="body-medium-default"
          className={SUMMARY_BLOCK_CLASS}
        >
          {details}
        </Typography>
      ) : null}

      {missingScopes.length > 0 ? (
        <div className="flex flex-col gap-[var(--app-spacing-xs)]">
          <Typography
            variant="body-small-emphasised"
            className="text-[var(--content-secondary)]"
          >
            {t("homeToolPermissionCard.missingScopes")}
          </Typography>
          <ul className="m-0 flex list-disc flex-col gap-[var(--app-spacing-xxs)] pl-[var(--app-spacing-lg)]">
            {missingScopes.map((scope) => (
              <li key={scope}>
                <Typography
                  variant="body-small-default"
                  className="text-[var(--content-tertiary)]"
                >
                  {scope}
                </Typography>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}
