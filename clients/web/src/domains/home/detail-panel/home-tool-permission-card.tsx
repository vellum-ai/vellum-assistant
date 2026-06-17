import type { FeedItem } from "@vellumai/assistant-api";
import { Typography } from "@vellumai/design-library";

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
  const metadata = item.metadata;
  const provider = metadata?.provider as string | undefined;

  if (!provider) {
    return (
      <Typography
        variant="body-medium-default"
        className="text-[var(--content-secondary)]"
      >
        {item.title ?? item.summary}
      </Typography>
    );
  }

  const accountInfo = (metadata?.accountInfo as string) ?? null;
  const status = (metadata?.status as string) ?? "unreachable";
  const details = (metadata?.details as string) ?? "";
  const missingScopes = Array.isArray(metadata?.missingScopes)
    ? (metadata.missingScopes as string[])
    : [];

  return (
    <div className="flex flex-col gap-[var(--app-spacing-md)]">
      <Typography variant="title-small" as="h3">
        {provider}
      </Typography>

      {accountInfo ? (
        <Typography
          variant="body-medium-lighter"
          className="text-[var(--content-secondary)]"
        >
          {accountInfo}
        </Typography>
      ) : null}

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
          {capitalizeStatus(status)}
        </Typography>
      </div>

      {details ? (
        <Typography
          variant="body-medium-lighter"
          className="text-[var(--content-secondary)]"
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
            Missing scopes
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
