import { useState, type FormEvent } from "react";

import {
    createSchedule,
    type CreateSchedulePayload,
} from "@/domains/settings/api/schedules";
import { Button } from "@vellumai/design-library/components/button";
import { Input, Textarea } from "@vellumai/design-library/components/input";
import { Modal } from "@vellumai/design-library/components/modal";

// ---------------------------------------------------------------------------
// Cron presets — cover the most common cases without forcing users to learn
// cron syntax. Free-form expression is still accepted for advanced cases.
// ---------------------------------------------------------------------------

interface CronPreset {
  readonly label: string;
  readonly expression: string;
}

const CRON_PRESETS: readonly CronPreset[] = [
  { label: "Every hour", expression: "0 * * * *" },
  { label: "Every day at 9am", expression: "0 9 * * *" },
  { label: "Every weekday at 9am", expression: "0 9 * * 1-5" },
  { label: "Every Monday at 9am", expression: "0 9 * * 1" },
  { label: "Every 1st of month, 9am", expression: "0 9 1 * *" },
];

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

export interface CreateScheduleModalProps {
  isOpen: boolean;
  assistantId: string;
  onClose: () => void;
  onCreated: () => void;
}

// ---------------------------------------------------------------------------
// Modal
// ---------------------------------------------------------------------------

export function CreateScheduleModal({
  isOpen,
  assistantId,
  onClose,
  onCreated,
}: CreateScheduleModalProps) {
  return (
    <Modal.Root
      open={isOpen}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      {isOpen ? (
        <CreateScheduleModalInner
          assistantId={assistantId}
          onClose={onClose}
          onCreated={onCreated}
        />
      ) : null}
    </Modal.Root>
  );
}

function CreateScheduleModalInner({
  assistantId,
  onClose,
  onCreated,
}: {
  assistantId: string;
  onClose: () => void;
  onCreated: () => void;
}) {
  const [name, setName] = useState("");
  const [expression, setExpression] = useState("");
  const [message, setMessage] = useState("");
  const [timezone, setTimezone] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  const trimmedName = name.trim();
  const trimmedExpression = expression.trim();
  const trimmedMessage = message.trim();
  const canSubmit =
    trimmedName.length > 0 &&
    trimmedExpression.length > 0 &&
    trimmedMessage.length > 0 &&
    !submitting;

  const onSubmit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (!canSubmit) return;
    setSubmitting(true);
    setSubmitError(null);
    try {
      const payload: CreateSchedulePayload = {
        name: trimmedName,
        expression: trimmedExpression,
        message: trimmedMessage,
      };
      const tz = timezone.trim();
      if (tz) payload.timezone = tz;
      await createSchedule(assistantId, payload);
      setSubmitting(false);
      onCreated();
    } catch (err) {
      setSubmitError(
        err instanceof Error
          ? err.message
          : "Failed to create schedule.",
      );
      setSubmitting(false);
    }
  };

  return (
    <Modal.Content size="md">
      <Modal.Header>
        <Modal.Title>Create schedule</Modal.Title>
        <Modal.Description>
          Schedule a recurring instruction for your assistant. Runs in
          execute mode — the message is delivered to the assistant on each
          fire.
        </Modal.Description>
      </Modal.Header>

      <form onSubmit={onSubmit}>
        <Modal.Body>
          <div className="flex flex-col gap-4">
            <Input
              label="Name"
              placeholder="Morning briefing"
              value={name}
              onChange={(e) => setName(e.target.value)}
              required
              autoFocus
              fullWidth
            />

            <div className="flex flex-col gap-1.5">
              <Input
                label="Cron expression"
                placeholder="0 9 * * *"
                value={expression}
                onChange={(e) => setExpression(e.target.value)}
                required
                fullWidth
                helperText="Standard 5-field cron (minute hour day month weekday). RRULE expressions are also accepted."
              />
              <div className="flex flex-wrap gap-1.5">
                {CRON_PRESETS.map((preset) => (
                  <Button
                    key={preset.expression}
                    variant="outlined"
                    size="compact"
                    type="button"
                    onClick={() => setExpression(preset.expression)}
                  >
                    {preset.label}
                  </Button>
                ))}
              </div>
            </div>

            <Input
              label="Timezone (optional)"
              placeholder="America/New_York"
              value={timezone}
              onChange={(e) => setTimezone(e.target.value)}
              fullWidth
              helperText="IANA timezone name. Leave blank to use UTC."
            />

            <Textarea
              label="Message"
              placeholder="What should the assistant do on each fire?"
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              required
              fullWidth
              rows={4}
            />

            {submitError ? (
              <p className="text-body-small-default text-[var(--system-negative-strong)]">
                {submitError}
              </p>
            ) : null}
          </div>
        </Modal.Body>

        <Modal.Footer>
          <Button variant="outlined" onClick={onClose} type="button">
            Cancel
          </Button>
          <Button variant="primary" type="submit" disabled={!canSubmit}>
            {submitting ? "Creating…" : "Create schedule"}
          </Button>
        </Modal.Footer>
      </form>
    </Modal.Content>
  );
}
