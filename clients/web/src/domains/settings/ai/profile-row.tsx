import { AlertCircle, EllipsisVertical } from "lucide-react";

import { Button } from "@vellumai/design-library/components/button";
import { ListRow } from "@vellumai/design-library/components/list-row";
import { Menu } from "@vellumai/design-library/components/menu";
import { Tag } from "@vellumai/design-library/components/tag";
import { Tooltip } from "@vellumai/design-library/components/tooltip";

import { resolveModelDisplayName } from "@/domains/settings/ai/model-display";
import { useTranslation } from "@/i18n";
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
  const { t } = useTranslation("settings");
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
    subtitleParts.push(t("profileRow.managedByVellum"));
  }

  const availability = profile.availability;
  const configIssue = profile.config_issue;
  // This row opens the profile editor, which is where a missing provider or
  // model is filled in. A connection or credential problem is repaired
  // elsewhere, and those messages already name where, so only the
  // `incomplete` availability case and a config issue (bad model or token
  // budget, both edited right here) invite a click: promising a fix the
  // editor cannot perform would send the user somewhere that does not help.
  const fixableHere =
    configIssue != null || availability?.status === "incomplete";
  const availabilityMessage =
    availability?.message ?? t("profileRow.providerUnavailableDefault");
  // A config issue outranks availability: the entry itself is wrong, so the
  // connection verdict behind it is secondary. Composed from catalog copy
  // keyed on the issue code, so the surface stays translated; the daemon's
  // English detail remains in the editor and CLI.
  const rowProblem =
    configIssue != null
      ? t("profileRow.providerUnavailableFixable", {
          message: t(
            configIssue.code === "over_output_cap"
              ? "profileRow.configIssueOverOutputCap"
              : configIssue.code === "no_input_room"
                ? "profileRow.configIssueNoInputRoom"
                : "profileRow.configIssueModelUnknown",
          ),
        })
      : availability != null && availability.status !== "ok"
        ? fixableHere
          ? t("profileRow.providerUnavailableFixable", {
              message: availabilityMessage,
            })
          : availabilityMessage
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
      contentAriaLabel={t("profileRow.openProfileAriaLabel", {
        displayName,
      })}
      trailingInteractive
      trailing={
        <>
          {rowProblem != null ? (
            <Tooltip content={rowProblem}>
              {fixableHere ? (
                <button
                  type="button"
                  onClick={onOpen}
                  aria-label={rowProblem}
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
                    aria-label={rowProblem}
                    role="img"
                  />
                </span>
              )}
            </Tooltip>
          ) : null}
          {isDisabled ? (
            <Tag tone="neutral">{t("profileRow.disabledTag")}</Tag>
          ) : null}
          {isActiveProfile ? (
            <Tag tone="positive">{t("profileRow.defaultTag")}</Tag>
          ) : null}
          <Menu.Root>
            <Menu.Trigger asChild>
              <Button
                variant="ghost"
                size="compact"
                iconOnly={<EllipsisVertical />}
                aria-label={t("profileRow.actionsAriaLabel", { displayName })}
                // The kebab sits outside the row's interactive content area,
                // so ListRow's own `disabled` does not reach it.
                disabled={deletePending}
              />
            </Menu.Trigger>
            <Menu.Content align="end" sideOffset={4}>
              <Menu.Item onSelect={onOpen}>
                {isManaged ? t("profileRow.view") : t("profileRow.edit")}
              </Menu.Item>
              {!isActiveProfile && !isDisabled ? (
                <Menu.Item onSelect={onMakeActive}>
                  {t("profileRow.makeDefault")}
                </Menu.Item>
              ) : null}
              {/* Managed profiles are enable-only: the daemon rejects the
                  disable direction. */}
              {isDisabled ? (
                <Menu.Item onSelect={() => onSetStatus(true)}>
                  {t("profileRow.enable")}
                </Menu.Item>
              ) : !isManaged ? (
                <Menu.Item onSelect={() => onSetStatus(false)}>
                  {t("profileRow.disable")}
                </Menu.Item>
              ) : null}
              {!isManaged ? (
                <Menu.Item
                  onSelect={onDelete}
                  className="text-[var(--system-negative-strong)] data-[highlighted]:text-[var(--system-negative-strong)]"
                >
                  {t("profileRow.delete")}
                </Menu.Item>
              ) : null}
            </Menu.Content>
          </Menu.Root>
        </>
      }
    />
  );
}
