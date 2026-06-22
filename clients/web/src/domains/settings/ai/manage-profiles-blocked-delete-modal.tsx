import { Button } from "@vellumai/design-library/components/button";
import { Dropdown } from "@vellumai/design-library/components/dropdown";
import { Modal } from "@vellumai/design-library/components/modal";
import { Typography } from "@vellumai/design-library/components/typography";

import type { ProfileWithName } from "@/domains/settings/ai/utils";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface BlockedDeleteState {
  name: string;
  label: string;
  isActive: boolean;
  callSiteIds: string[];
}

// ---------------------------------------------------------------------------
// BlockedDeleteModal
// ---------------------------------------------------------------------------

export function BlockedDeleteModal({
  blocked,
  availableReplacements,
  replacement,
  onReplacementChange,
  error,
  saving,
  onClose,
  onConfirm,
}: {
  blocked: BlockedDeleteState | null;
  availableReplacements: ProfileWithName[];
  replacement: string;
  onReplacementChange: (value: string) => void;
  error: string | null;
  saving: boolean;
  onClose: () => void;
  onConfirm: () => void;
}) {
  let summary = "";
  if (blocked) {
    const display = blocked.label || blocked.name;
    if (blocked.isActive && blocked.callSiteIds.length > 0) {
      summary = `"${display}" is the active profile and is used by ${blocked.callSiteIds.length} call site(s). Pick a replacement profile.`;
    } else if (blocked.isActive) {
      summary = `"${display}" is the active profile. Pick a different active profile before deleting, or select a replacement below.`;
    } else {
      summary = `"${display}" is used by ${blocked.callSiteIds.length} call site(s). Select a replacement profile to reassign them before deleting.`;
    }
  }

  return (
    <Modal.Root
      open={blocked !== null}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <Modal.Content size="sm">
        <Modal.Header>
          <Modal.Title>Can&apos;t Delete Profile</Modal.Title>
        </Modal.Header>
        <Modal.Body className="space-y-4">
          <Typography variant="body-medium-default" as="p">
            {summary}
          </Typography>
          {blocked && blocked.callSiteIds.length > 0 && (
            <ul className="space-y-1 pl-1">
              {blocked.callSiteIds.map((id) => (
                <li
                  key={id}
                  className="text-body-small-default text-(--content-secondary)"
                >
                  • <code>{id}</code>
                </li>
              ))}
            </ul>
          )}
          <div className="space-y-1">
            <label className="block text-body-small-default text-[var(--content-tertiary)]">
              Replacement profile
            </label>
            <Dropdown
              aria-label="Replacement profile"
              value={replacement}
              onChange={onReplacementChange}
              options={[
                { value: "", label: "Select a replacement…" },
                ...availableReplacements.map((p) => ({
                  value: p.name,
                  label: p.label ?? p.name,
                })),
              ]}
            />
          </div>
          {error && (
            <Typography
              variant="body-small-default"
              as="p"
              className="text-(--system-negative-strong)"
            >
              {error}
            </Typography>
          )}
        </Modal.Body>
        <Modal.Footer>
          <Button variant="ghost" size="compact" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            size="compact"
            disabled={!replacement || saving}
            onClick={onConfirm}
          >
            {saving ? "Saving…" : "Reassign and Delete"}
          </Button>
        </Modal.Footer>
      </Modal.Content>
    </Modal.Root>
  );
}
