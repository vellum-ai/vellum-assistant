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
      contentAriaLabel={onOpen ? `Open provider ${displayName}` : undefined}
      trailingInteractive
      trailing={
        <>
          {isManaged ? (
            <Tag tone="neutral" title="Runs on Vellum's managed credentials.">
              Managed
            </Tag>
          ) : null}
          {isDefault ? (
            <Tag
              tone="info"
              title="Built-in profiles (Balanced, Quality, Cost, Speed) use this provider."
            >
              Default
            </Tag>
          ) : null}
          {connection.provider === "ollama" ? (
            <Tag tone="neutral" title="Runs models on this machine.">
              Local
            </Tag>
          ) : null}
          {connection.provider === "openai-compatible" ? (
            <Tag
              tone="neutral"
              title="A provider you created, served by an OpenAI-compatible endpoint."
            >
              Custom
            </Tag>
          ) : null}
          {hasMenu ? (
            <Menu.Root>
              <Menu.Trigger asChild>
                <Button
                  variant="ghost"
                  size="compact"
                  iconOnly={<EllipsisVertical />}
                  aria-label={`Actions for ${displayName}`}
                />
              </Menu.Trigger>
              <Menu.Content align="end" sideOffset={4}>
                {showEdit ? (
                  <Menu.Item onSelect={onOpen}>Edit</Menu.Item>
                ) : null}
                {showSetDefault ? (
                  <Menu.Item disabled={isSettingDefault} onSelect={onSetDefault}>
                    Set as default
                  </Menu.Item>
                ) : null}
                {showDelete ? (
                  <Menu.Item
                    onSelect={onDelete}
                    className="text-[var(--system-negative-strong)] data-[highlighted]:text-[var(--system-negative-strong)]"
                  >
                    Delete
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
