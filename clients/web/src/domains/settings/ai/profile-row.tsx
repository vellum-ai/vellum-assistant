import { AlertCircle, EllipsisVertical } from "lucide-react";

import { Button } from "@vellumai/design-library/components/button";
import { ListRow } from "@vellumai/design-library/components/list-row";
import { Menu } from "@vellumai/design-library/components/menu";
import { Tag } from "@vellumai/design-library/components/tag";
import { Tooltip } from "@vellumai/design-library/components/tooltip";

import { resolveModelDisplayName } from "@/domains/settings/ai/model-display";
import type {
  InferenceProfileSummary,
  ProviderConnection,
} from "@/generated/daemon/types.gen";

interface ProfileRowProps {
  profile: InferenceProfileSummary;
  /** This profile is `llm.activeProfile` - the main-chat default. */
  isActiveProfile: boolean;
  /** The row's panel is currently open in the sidepanel. */
  selected: boolean;
  /** Connection rows, for resolving openai-compatible model display names. */
  connections?: ProviderConnection[];
  /**
   * A delete of this profile is scanning for references. The row dims and
   * stops responding until the scan resolves, so the round trip does not read
   * as a dead menu item.
   */
  deletePending?: boolean;
  /** Open the profile in the sidepanel (view for managed, edit for user). */
  onOpen: () => void;
  onMakeActive: () => void;
  onSetStatus: (active: boolean) => void;
  onDelete: () => void;
}

/**
 * One row of the Profiles section (Figma 7412:133380): label, a
 * "{model} • Managed by Vellum" subtitle, the Default chip, and a kebab
 * menu showing only the actions valid for this row (per the design
 * annotation on Light 738). Clicking the row opens the profile in the
 * sidepanel.
 *
 * Wording note: the chip for `llm.activeProfile` reads "Default" - the
 * default profile for chats that haven't picked one. "Active"/"Disabled"
 * is the orthogonal `status` dimension (picker visibility), rendered as
 * the dimmed title + "Disabled" chip + Enable/Disable menu items.
 *
 * The advisor (`llm.advisorProfile`) is a per-action model choice, not a
 * per-profile property, so it lives in the Action Overrides panel.
 */
export function ProfileRow({
  profile,
  isActiveProfile,
  selected,
  connections,
  deletePending = false,
  onOpen,
  onMakeActive,
  onSetStatus,
  onDelete,
}: ProfileRowProps) {
  const isManaged = profile.source === "managed";
  const isDisabled = profile.status === "disabled";
  const displayName = profile.label ?? profile.name;

  const subtitleParts: string[] = [];
  if (profile.model) {
    subtitleParts.push(
      resolveModelDisplayName(
        profile.provider ?? undefined,
        profile.model,
        connections,
      ),
    );
  }
  if (isManaged) {
    subtitleParts.push("Managed by Vellum");
  }

  const availability = profile.availability;
  // This row opens the profile editor, which is where a missing provider or
  // model is filled in. A connection or credential problem is repaired
  // elsewhere, and those messages already name where, so only the
  // `incomplete` case invites a click: promising a fix the editor cannot
  // perform would send the user somewhere that does not help.
  const fixableHere = availability?.status === "incomplete";
  const availabilityProblem =
    availability != null && availability.status !== "ok"
      ? `${availability.message ?? "This profile's provider is not available."}${fixableHere ? " Click to fix." : ""}`
      : null;

  return (
    <ListRow
      title={
        <span className={isDisabled ? "opacity-55" : undefined}>
          {displayName}
        </span>
      }
      subtitle={
        subtitleParts.length > 0 ? subtitleParts.join("  •  ") : undefined
      }
      onClick={onOpen}
      showChevron={false}
      selected={selected}
      disabled={deletePending}
      contentAriaLabel={`Open profile ${displayName}`}
      trailingInteractive
      trailing={
        <>
          {availabilityProblem != null ? (
            <Tooltip content={availabilityProblem}>
              {fixableHere ? (
                <button
                  type="button"
                  onClick={onOpen}
                  aria-label={availabilityProblem}
                  className="inline-flex cursor-pointer rounded-sm p-0.5 keyboard-focus:ring-2 keyboard-focus:ring-[var(--ring)]"
                >
                  <AlertCircle
                    className="h-4 w-4 text-[var(--system-mid-strong)]"
                    aria-hidden="true"
                  />
                </button>
              ) : (
                <span className="inline-flex p-0.5" tabIndex={0}>
                  <AlertCircle
                    className="h-4 w-4 text-[var(--system-mid-strong)]"
                    aria-label={availabilityProblem}
                    role="img"
                  />
                </span>
              )}
            </Tooltip>
          ) : null}
          {isDisabled ? <Tag tone="neutral">Disabled</Tag> : null}
          {isActiveProfile ? <Tag tone="positive">Default</Tag> : null}
          <Menu.Root>
            <Menu.Trigger asChild>
              <Button
                variant="ghost"
                size="compact"
                iconOnly={<EllipsisVertical />}
                aria-label={`Actions for ${displayName}`}
                // The kebab sits outside the row's interactive content area,
                // so ListRow's own `disabled` does not reach it.
                disabled={deletePending}
              />
            </Menu.Trigger>
            <Menu.Content align="end" sideOffset={4}>
              <Menu.Item onSelect={onOpen}>
                {isManaged ? "View" : "Edit"}
              </Menu.Item>
              {!isActiveProfile && !isDisabled ? (
                <Menu.Item onSelect={onMakeActive}>Make Default</Menu.Item>
              ) : null}
              {/* Managed profiles are enable-only: the daemon rejects the
                  disable direction. */}
              {isDisabled ? (
                <Menu.Item onSelect={() => onSetStatus(true)}>Enable</Menu.Item>
              ) : !isManaged ? (
                <Menu.Item onSelect={() => onSetStatus(false)}>
                  Disable
                </Menu.Item>
              ) : null}
              {!isManaged ? (
                <Menu.Item
                  onSelect={onDelete}
                  className="text-[var(--system-negative-strong)] data-[highlighted]:text-[var(--system-negative-strong)]"
                >
                  Delete
                </Menu.Item>
              ) : null}
            </Menu.Content>
          </Menu.Root>
        </>
      }
    />
  );
}
