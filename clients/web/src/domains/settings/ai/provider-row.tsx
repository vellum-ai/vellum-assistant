import { EllipsisVertical } from "lucide-react";

import { Button } from "@vellumai/design-library/components/button";
import { ListRow } from "@vellumai/design-library/components/list-row";
import { Menu } from "@vellumai/design-library/components/menu";
import { Tag } from "@vellumai/design-library/components/tag";

import { providerConnectionDisplayName } from "@/domains/settings/ai/provider-editor-constants";
import {
  isDefaultProviderId,
  providerRowMeta,
} from "@/domains/settings/ai/provider-row-meta";
import type { ProviderConnection } from "@/generated/daemon/types.gen";
import { useTranslation } from "@/i18n";

interface ProviderRowProps {
  connection: ProviderConnection;
  /** This connection is what the default provider resolves to. */
  isDefault: boolean;
  /** False against assistants that predate the default-provider routes. */
  supportsDefaultProvider: boolean;
  /** The row's panel is currently open in the sidepanel. */
  selected: boolean;
  isSettingDefault: boolean;
  /** Open the connection in the sidepanel editor. Absent for managed rows. */
  onOpen?: () => void;
  onSetDefault: () => void;
  onDelete: () => void;
}

/**
 * One row of the Providers section (Figma 7412:133539): display name, a
 * "{models}  •  {auth}" meta line, Default/Managed/Local/Custom chips, and
 * a kebab menu with the actions valid for this row. Clicking a row opens
 * the connection in the sidepanel editor; the managed Vellum row is not
 * editable (platform-owned auth), so it exposes no open affordance and its
 * kebab carries only Set as default.
 */
export function ProviderRow({
  connection,
  isDefault,
  supportsDefaultProvider,
  selected,
  isSettingDefault,
  onOpen,
  onSetDefault,
  onDelete,
}: ProviderRowProps) {
  const { t } = useTranslation("settings");
  const isManaged = connection.isManaged ?? false;
  const displayName = providerConnectionDisplayName(connection);
  const eligibleForDefault = isDefaultProviderId(connection.provider);
  const meta = providerRowMeta(connection);

  const showSetDefault =
    supportsDefaultProvider && !isDefault && eligibleForDefault;
  const showEdit = !isManaged && onOpen != null;
  // Managed (Vellum) connections are platform-owned and the default
  // provider must always resolve somewhere, so neither is deletable.
  const showDelete = !isManaged && !isDefault;
  const hasMenu = showSetDefault || showEdit || showDelete;

  return (
    <ListRow
      title={displayName}
      subtitle={meta.length > 0 ? meta : undefined}
      onClick={onOpen}
      showChevron={false}
      selected={selected}
      contentAriaLabel={
        onOpen
          ? t("providerRow.openProviderAriaLabel", { displayName })
          : undefined
      }
      trailingInteractive
      trailing={
        <>
          {isManaged ? (
            <Tag
              tone="neutral"
              title={t("providerRow.managedTagTitle")}
            >
              {t("providerRow.managedTag")}
            </Tag>
          ) : null}
          {isDefault ? (
            <Tag tone="info" title={t("providerRow.defaultTagTitle")}>
              {t("providerRow.defaultTag")}
            </Tag>
          ) : null}
          {connection.provider === "ollama" ? (
            <Tag tone="neutral" title={t("providerRow.localTagTitle")}>
              {t("providerRow.localTag")}
            </Tag>
          ) : null}
          {connection.provider === "openai-compatible" ? (
            <Tag tone="neutral" title={t("providerRow.customTagTitle")}>
              {t("providerRow.customTag")}
            </Tag>
          ) : null}
          {hasMenu ? (
            <Menu.Root>
              <Menu.Trigger asChild>
                <Button
                  variant="ghost"
                  size="compact"
                  iconOnly={<EllipsisVertical />}
                  aria-label={t("providerRow.actionsAriaLabel", {
                    displayName,
                  })}
                />
              </Menu.Trigger>
              <Menu.Content align="end" sideOffset={4}>
                {showEdit ? (
                  <Menu.Item onSelect={onOpen}>
                    {t("providerRow.edit")}
                  </Menu.Item>
                ) : null}
                {showSetDefault ? (
                  <Menu.Item disabled={isSettingDefault} onSelect={onSetDefault}>
                    {t("providerRow.setAsDefault")}
                  </Menu.Item>
                ) : null}
                {showDelete ? (
                  <Menu.Item
                    onSelect={onDelete}
                    className="text-[var(--system-negative-strong)] data-[highlighted]:text-[var(--system-negative-strong)]"
                  >
                    {t("providerRow.delete")}
                  </Menu.Item>
                ) : null}
              </Menu.Content>
            </Menu.Root>
          ) : (
            // Keep row heights aligned when a managed row has no menu (the
            // default Vellum row with default-provider support absent).
            <span className="inline-block w-8" aria-hidden />
          )}
        </>
      }
    />
  );
}
