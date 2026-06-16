/**
 * `ChannelPolicyCard` — settings card surface for the per-channel
 * admission floor (§8.1). Lists every client-controllable channel with a
 * dropdown for its floor. Internal channels (`vellum`/`platform`/`a2a`)
 * are filtered out by `fetchChannelPolicies` and never rendered here, so
 * the user can't accidentally lock themselves out of the local desktop or
 * platform connection.
 */

import { ShieldAlert } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";

import { useActiveAssistantId } from "@/assistant/use-active-assistant-id";
import {
  fetchChannelPolicies,
  setChannelPolicy,
  ApiError,
} from "@/lib/channel-admission-policy/api";
import {
  ADMISSION_POLICY_VALUES,
  POLICY_DESCRIPTIONS,
  POLICY_LABELS,
  type AdmissionPolicy,
  type ChannelPolicyView,
} from "@/lib/channel-admission-policy/types";
import { Card } from "@vellumai/design-library/components/card";
import { Dropdown } from "@vellumai/design-library/components/dropdown";

const DROPDOWN_OPTIONS = ADMISSION_POLICY_VALUES.map((value) => ({
  value,
  label: POLICY_LABELS[value],
}));

function humaniseChannel(channelType: string): string {
  // Map known channel ids to display labels; fall back to a Title-Case
  // version of the id so future channels render OK without a code change.
  const LABELS: Record<string, string> = {
    telegram: "Telegram",
    phone: "Phone / SMS",
    whatsapp: "WhatsApp",
    slack: "Slack",
    email: "Email",
  };
  return (
    LABELS[channelType] ??
    channelType.charAt(0).toUpperCase() + channelType.slice(1)
  );
}

export function ChannelPolicyCard() {
  const assistantId = useActiveAssistantId();
  const [policies, setPolicies] = useState<ChannelPolicyView[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [savingChannel, setSavingChannel] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const fetched = await fetchChannelPolicies(assistantId);
      setPolicies(fetched);
    } catch (err) {
      const msg =
        err instanceof ApiError ? err.message : "Failed to load channel policies.";
      setError(msg);
    } finally {
      setLoading(false);
    }
  }, [assistantId]);

  useEffect(() => {
    void load();
  }, [load]);

  const handleChange = useCallback(
    async (channelType: string, next: AdmissionPolicy) => {
      setSavingChannel(channelType);
      setError(null);
      // Optimistic update — snap the row to `next` so the dropdown reflects
      // intent immediately; the API call may overwrite this with the
      // server-returned row (e.g. updatedAt).
      setPolicies((prev) =>
        prev
          ? prev.map((p) =>
              p.channelType === channelType ? { ...p, policy: next } : p,
            )
          : prev,
      );
      try {
        const saved = await setChannelPolicy(assistantId, channelType, next);
        setPolicies((prev) =>
          prev
            ? prev.map((p) => (p.channelType === channelType ? saved : p))
            : prev,
        );
      } catch (err) {
        const msg =
          err instanceof ApiError
            ? err.message
            : "Failed to save channel policy.";
        setError(msg);
        // Reload to recover the canonical server state.
        await load();
      } finally {
        setSavingChannel(null);
      }
    },
    [assistantId, load],
  );

  const visible = useMemo(() => policies ?? [], [policies]);

  return (
    <Card>
      <div className="flex items-start gap-3">
        <ShieldAlert className="mt-0.5 h-5 w-5 shrink-0 text-[var(--content-secondary)]" />
        <div className="flex-1">
          <h2 className="text-title-medium text-[var(--content-default)]">
            Channel Trust Floors
          </h2>
          <p className="mt-1 text-body-medium-lighter text-[var(--content-tertiary)]">
            Choose who can reach the assistant on each channel. Internal
            channels are managed automatically and not shown here.
          </p>
        </div>
      </div>

      {error && (
        <div
          role="alert"
          className="mt-4 rounded-md border border-[var(--border-negative)] bg-[var(--surface-negative-subtle)] px-3 py-2 text-body-small-default text-[var(--content-negative)]"
        >
          {error}
        </div>
      )}

      <div className="mt-4 space-y-3" data-testid="channel-policy-list">
        {loading && !policies && (
          <p className="text-body-small-default text-[var(--content-tertiary)]">
            Loading…
          </p>
        )}
        {!loading && visible.length === 0 && (
          <p className="text-body-small-default text-[var(--content-tertiary)]">
            No client-controllable channels found.
          </p>
        )}
        {visible.map((policy) => (
          <div
            key={policy.channelType}
            className="flex items-center justify-between gap-4"
            data-testid={`channel-policy-row-${policy.channelType}`}
          >
            <div className="flex-1">
              <div className="text-body-medium-default text-[var(--content-default)]">
                {humaniseChannel(policy.channelType)}
              </div>
              <p className="text-body-small-default text-[var(--content-tertiary)]">
                {POLICY_DESCRIPTIONS[policy.policy]}
              </p>
            </div>
            <div style={{ minWidth: 220 }}>
              <Dropdown<AdmissionPolicy>
                value={policy.policy}
                onChange={(next) => void handleChange(policy.channelType, next)}
                options={DROPDOWN_OPTIONS}
                disabled={savingChannel === policy.channelType}
                aria-label={`Floor for ${humaniseChannel(policy.channelType)}`}
                data-testid={`channel-policy-dropdown-${policy.channelType}`}
              />
            </div>
          </div>
        ))}
      </div>
    </Card>
  );
}
