import { GripVertical, Trash2 } from "lucide-react";

import { Button } from "@vellumai/design-library/components/button";
import { Tag } from "@vellumai/design-library/components/tag";
import { Toggle } from "@vellumai/design-library/components/toggle";
import { Typography } from "@vellumai/design-library/components/typography";

import type { ProfileWithName } from "@/domains/settings/ai/utils";
import { AUTO_PROFILE_NAME } from "@/assistant/profile-pickers";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface DropTarget {
  name: string;
  after: boolean;
}

interface ProfileListItemProps {
  profile: ProfileWithName;
  isDragging: boolean;
  dropTarget: DropTarget | null;
  isDeleting: boolean;
  deleteError: string | undefined;
  isToggling: boolean;
  onDragStart: (e: React.DragEvent) => void;
  onDragEnd: () => void;
  onDragOver: (e: React.DragEvent) => void;
  onDragLeave: (e: React.DragEvent) => void;
  onDrop: (e: React.DragEvent) => void;
  onEditClick: () => void;
  onDeleteClick: () => void;
  onStatusToggle: (active: boolean) => void;
}

// ---------------------------------------------------------------------------
// ProfileListItem
// ---------------------------------------------------------------------------

export function ProfileListItem({
  profile,
  isDragging,
  dropTarget,
  isDeleting,
  deleteError,
  isToggling,
  onDragStart,
  onDragEnd,
  onDragOver,
  onDragLeave,
  onDrop,
  onEditClick,
  onDeleteClick,
  onStatusToggle,
}: ProfileListItemProps) {
  const isManaged = profile.source === "managed";
  const isActive = profile.status !== "disabled";
  const isAutoProfile = profile.name === AUTO_PROFILE_NAME;

  return (
    <div className="relative">
      {dropTarget?.name === profile.name && !dropTarget.after && (
        <div className="mx-0 h-0.5 rounded-full bg-[var(--border-active)]" />
      )}
      <div
        className={`flex items-center gap-2 rounded-lg pr-2 py-2${isDragging ? " opacity-50" : ""}`}
        draggable={!isManaged}
        onDragStart={onDragStart}
        onDragEnd={onDragEnd}
        onDragOver={onDragOver}
        onDragLeave={onDragLeave}
        onDrop={onDrop}
      >
        {/* Grip icon — invisible for managed profiles to preserve alignment */}
        <GripVertical
          className={`h-4 w-4 shrink-0 ${isManaged ? "invisible" : "cursor-grab text-[var(--content-tertiary)]"}`}
        />

        {/* Label — dimmed when disabled */}
        <div
          className={`min-w-0 flex-1${isActive ? "" : " opacity-55"}`}
        >
          <div className="flex items-center gap-2">
            <Typography
              variant="body-medium-default"
              as="span"
              className="text-(--content-default)"
            >
              {profile.label ?? profile.name}
            </Typography>
            {isManaged && profile.name !== AUTO_PROFILE_NAME && (
              <Tag
                tone="positive"
                title="Managed by Platform — auth is locked, but you can rename or disable this profile."
              >
                Platform
              </Tag>
            )}
          </div>
          {profile.description ? (
            <Typography
              variant="body-medium-lighter"
              as="p"
              className="mt-0.5 text-(--content-tertiary)"
            >
              {profile.description}
            </Typography>
          ) : null}
          {(profile.model ?? profile.provider) ? (
            <Typography
              variant="body-medium-lighter"
              as="p"
              className="mt-0.5 text-(--content-tertiary)"
            >
              {profile.model ?? profile.provider}
            </Typography>
          ) : null}
        </div>

        {/* Actions */}
        <div className="flex shrink-0 items-center gap-2">
          <div
            className="flex shrink-0 items-center"
            title={
              isActive
                ? "Active — toggle to hide from pickers"
                : "Disabled — toggle to show in pickers"
            }
          >
            <Toggle
              checked={isActive}
              onChange={(next) => onStatusToggle(next)}
              disabled={isToggling}
              aria-label={`${isActive ? "Disable" : "Enable"} ${profile.label ?? profile.name}`}
            />
          </div>
          <div
            className={`flex w-[92px] items-center justify-end gap-2${isAutoProfile ? " invisible" : ""}`}
          >
            <Button
              variant="ghost"
              size="compact"
              onClick={onEditClick}
            >
              {isManaged ? "View" : "Edit"}
            </Button>
            <Button
              variant="ghost"
              size="compact"
              iconOnly={<Trash2 />}
              aria-label={`Delete ${profile.label ?? profile.name}`}
              disabled={isManaged || isDeleting}
              title={
                isManaged ? "Managed profiles cannot be deleted" : undefined
              }
              onClick={onDeleteClick}
              tintColor="var(--system-negative-strong)"
            />
          </div>
        </div>
      </div>
      {dropTarget?.name === profile.name && dropTarget.after && (
        <div className="mx-0 h-0.5 rounded-full bg-[var(--border-active)]" />
      )}
      {deleteError ? (
        <Typography
          variant="body-small-default"
          as="p"
          className="px-2 pb-1 text-(--system-negative-strong)"
        >
          {deleteError}
        </Typography>
      ) : null}
      {profile.name === AUTO_PROFILE_NAME && (
        <div className="mx-2 mt-1 border-b border-[var(--border-subtle)]" />
      )}
    </div>
  );
}
