/**
 * In-app link for a unique conversation title or schedule name that
 * `rehypeEntityName` flagged in assistant-authored markdown.
 */

import type { ReactNode } from "react";
import { Link } from "react-router";

import { EXTERNAL_LINK_CLASS } from "@/components/external-anchor";
import type { EntityNameKind } from "@/domains/chat/utils/entity-name-links";
import { useTranslation } from "@/i18n";
import { routes } from "@/utils/routes";

export interface EntityNameLinkProps {
  kind?: EntityNameKind | string;
  entityId?: string;
  /** Matched text, used for the tooltip even when children are wrap spans. */
  name?: string;
  children?: ReactNode;
}

function destinationFor(
  kind: string | undefined,
  entityId: string,
): string | null {
  if (kind === "conversation") {
    return routes.conversation(entityId);
  }
  if (kind === "schedule") {
    return routes.schedules.detail(entityId);
  }
  return null;
}

export function EntityNameLink({
  kind,
  entityId,
  entityid,
  name,
  children,
}: EntityNameLinkProps & { entityid?: string }) {
  const { t } = useTranslation("chat");
  const id = entityId ?? entityid;
  if (!id) {
    return <>{children}</>;
  }
  const to = destinationFor(kind, id);
  if (!to) {
    return <>{children}</>;
  }
  const label = name ?? "";
  const title =
    kind === "schedule"
      ? t("entityNameLink.openSchedule", { name: label })
      : t("entityNameLink.openConversation", { name: label });

  return (
    <Link to={to} className={EXTERNAL_LINK_CLASS} title={title}>
      {children}
    </Link>
  );
}
