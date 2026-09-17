import { Cable, KeyRound, ShieldCheck, type LucideIcon } from "lucide-react";
import { useCallback, type ReactNode } from "react";

import { ActionMenu } from "@vellumai/design-library/components/action-menu";

import { useTranslation } from "@/i18n";

import type { ConnectMethod, ConnectMethodKind } from "./connect-plan";

/**
 * How each connect method is drawn, wherever it is offered.
 *
 * The tile's chevron menu and the modal's list are the same four choices in
 * two places. A user who learns that the plug means "the provider's own
 * server" on one surface should not have to learn it again on the other, so
 * the glyph, the wording, and the menu row all come from here.
 */
export const CONNECT_METHOD_ICONS: Record<ConnectMethodKind, LucideIcon> = {
  "mcp-oauth": Cable,
  "mcp-manual": Cable,
  "managed-oauth": ShieldCheck,
  "own-oauth": KeyRound,
};

/**
 * Names a method after the integration it connects, e.g. "Notion MCP server".
 *
 * A manual setup names the work rather than the server, because it sits in a
 * list beside the same server's OAuth entry and the two would otherwise read
 * identically.
 */
export function useConnectMethodLabel(
  name: string,
): (method: ConnectMethod) => string {
  const { t } = useTranslation("settings");

  return useCallback(
    (method: ConnectMethod) => {
      switch (method.kind) {
        case "mcp-oauth":
          return t("connectMethod.mcp", { name });
        case "mcp-manual":
          return t("connectMethod.mcpManual");
        case "managed-oauth":
          return t("connectMethod.managed");
        case "own-oauth":
          return t("connectMethod.own");
      }
    },
    [t, name],
  );
}

/**
 * The methods as `ActionMenu.Item`s. A list rather than a component, so each
 * item stays a direct child of the menu content that renders it.
 */
export function connectMethodMenuItems(
  methods: ConnectMethod[],
  label: (method: ConnectMethod) => string,
  onPick: (method: ConnectMethod) => void,
): ReactNode[] {
  return methods.map((method) => (
    <ActionMenu.Item
      key={method.id}
      icon={CONNECT_METHOD_ICONS[method.kind]}
      label={label(method)}
      onSelect={() => onPick(method)}
    />
  ));
}
