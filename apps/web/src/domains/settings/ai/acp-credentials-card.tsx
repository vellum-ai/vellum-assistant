import type { ReactNode } from "react";
import { CircleCheck, Loader2, ShieldCheck } from "lucide-react";
import { useCallback, useState } from "react";

import { Button } from "@vellum/design-library/components/button";
import { Dropdown } from "@vellum/design-library/components/dropdown";
import { Input } from "@vellum/design-library/components/input";
import { Notice } from "@vellum/design-library/components/notice";
import { Typography } from "@vellum/design-library/components/typography";

import { acpCredentialsLinkPost } from "@/generated/daemon/sdk.gen";
import type { AcpCredentialsLinkPostData } from "@/generated/daemon/types.gen";
import { DetailCard } from "@/components/detail-card";
import { extractErrorMessage } from "@/utils/api-errors";
import { captureError } from "@/lib/sentry/capture-error";

// ---------------------------------------------------------------------------
// AcpCredentialsCard — "Connect Claude Code / Codex + Git"
// ---------------------------------------------------------------------------
//
// Links the four per-user ACP/dev credentials into the user's private in-pod
// environment via the write-only `acp/credentials/link` daemon route
// (operationId acp_link_credential). Each secret is stored ONLY in the pod's
// secure store under acp/<field>; it is never returned in the response and
// never sent to Vellum's central servers.
//
// Linked-state caveat: the link route is write-only — there is no read/list
// endpoint to recover which credentials are present after a reload. We derive
// linked state optimistically: a successful link call marks that field linked
// in component-local state for the session; "Unlink" clears it locally so the
// user can re-enter a value. (Unlinking here is a UI affordance to re-link; a
// dedicated server-side delete route is out of scope for D2.)

type AcpField = AcpCredentialsLinkPostData["body"]["field"];

type ClaudeMode = "claude_oauth_token" | "anthropic_api_key";

interface AcpCredentialsCardProps {
  assistantId: string | undefined;
}

const CLAUDE_MODE_OPTIONS: { value: ClaudeMode; label: string }[] = [
  { value: "claude_oauth_token", label: "Claude OAuth token" },
  { value: "anthropic_api_key", label: "Anthropic API key" },
];

const FIELD_LABEL: Record<AcpField, string> = {
  claude_oauth_token: "Claude OAuth token",
  anthropic_api_key: "Anthropic API key",
  openai_api_key: "OpenAI API key",
  git_token: "Git token",
};

export function AcpCredentialsCard({ assistantId }: AcpCredentialsCardProps) {
  // Which Claude credential the user wants to link.
  const [claudeMode, setClaudeMode] = useState<ClaudeMode>("claude_oauth_token");

  // Draft values, never persisted anywhere other than the in-pod store.
  const [claudeValue, setClaudeValue] = useState("");
  const [openaiValue, setOpenaiValue] = useState("");
  const [gitValue, setGitValue] = useState("");

  // Optimistic linked state (see caveat above). Tracks the specific field that
  // was linked so the Claude row reflects OAuth-vs-API-key choice.
  const [linked, setLinked] = useState<Partial<Record<AcpField, boolean>>>({});

  // Per-field in-flight + error state.
  const [pending, setPending] = useState<Partial<Record<AcpField, boolean>>>({});
  const [errors, setErrors] = useState<Partial<Record<AcpField, string>>>({});

  const linkField = useCallback(
    async (field: AcpField, value: string) => {
      if (!assistantId) return;
      const trimmed = value.trim();
      if (!trimmed) {
        setErrors((e) => ({ ...e, [field]: "Enter a value to link." }));
        return;
      }
      setErrors((e) => ({ ...e, [field]: undefined }));
      setPending((p) => ({ ...p, [field]: true }));
      try {
        await acpCredentialsLinkPost({
          path: { assistant_id: assistantId },
          body: { field, value: trimmed },
          throwOnError: true,
        });
        setLinked((l) => ({ ...l, [field]: true }));
        // For Claude, only one of the two fields can be the active credential;
        // clear the other so the UI shows a single linked Claude credential.
        if (field === "claude_oauth_token" || field === "anthropic_api_key") {
          const other: AcpField =
            field === "claude_oauth_token"
              ? "anthropic_api_key"
              : "claude_oauth_token";
          setLinked((l) => ({ ...l, [other]: false }));
        }
      } catch (err) {
        captureError(err, { context: "acp_link_credential", bestEffort: true });
        setErrors((e) => ({
          ...e,
          [field]: extractErrorMessage(
            err,
            undefined,
            "Failed to link credential. Please try again.",
          ),
        }));
      } finally {
        setPending((p) => ({ ...p, [field]: false }));
      }
    },
    [assistantId],
  );

  const unlinkField = useCallback((field: AcpField, clear: () => void) => {
    // Write-only route: no server delete in D2, so unlink is a local reset that
    // lets the user enter and re-link a fresh value.
    setLinked((l) => ({ ...l, [field]: false }));
    setErrors((e) => ({ ...e, [field]: undefined }));
    clear();
  }, []);

  return (
    <DetailCard
      id="coding-credentials"
      title="Connect Claude Code / Codex + Git"
      subtitle="Bring your own credentials so the coding agent can run in your private environment."
    >
      <div className="h-px bg-[var(--surface-active)]" />

      <div className="mt-4 space-y-5">
        <Notice tone="info" icon={<ShieldCheck className="h-4 w-4" aria-hidden />}>
          These secrets are stored only in your private environment and are
          never sent to our servers. They&apos;re write-only: once linked, the
          value can&apos;t be read back.
        </Notice>

        {!assistantId ? (
          <Typography
            variant="body-small-default"
            as="p"
            className="text-[var(--content-tertiary)]"
          >
            No assistant found yet.
          </Typography>
        ) : (
          <>
            {/* Claude credential (OAuth token OR Anthropic API key) */}
            <CredentialRow
              title="Claude Code"
              description="Link a Claude OAuth token or an Anthropic API key for the Claude coding agent."
              field={claudeMode}
              linked={
                linked.claude_oauth_token === true ||
                linked.anthropic_api_key === true
              }
              linkedLabel={
                linked.claude_oauth_token
                  ? FIELD_LABEL.claude_oauth_token
                  : linked.anthropic_api_key
                    ? FIELD_LABEL.anthropic_api_key
                    : undefined
              }
              value={claudeValue}
              onValueChange={setClaudeValue}
              pending={
                pending.claude_oauth_token === true ||
                pending.anthropic_api_key === true
              }
              error={errors[claudeMode]}
              onLink={() => void linkField(claudeMode, claudeValue)}
              onUnlink={() => {
                const linkedField: AcpField = linked.anthropic_api_key
                  ? "anthropic_api_key"
                  : "claude_oauth_token";
                unlinkField(linkedField, () => setClaudeValue(""));
              }}
              extraControl={
                <Dropdown<ClaudeMode>
                  value={claudeMode}
                  onChange={(val) => {
                    setClaudeMode(val);
                    setClaudeValue("");
                    setErrors((e) => ({
                      ...e,
                      claude_oauth_token: undefined,
                      anthropic_api_key: undefined,
                    }));
                  }}
                  options={CLAUDE_MODE_OPTIONS}
                />
              }
            />

            {/* OpenAI API key (Codex) */}
            <CredentialRow
              title="Codex (OpenAI)"
              description="Link an OpenAI API key for the Codex coding agent."
              field="openai_api_key"
              linked={linked.openai_api_key === true}
              value={openaiValue}
              onValueChange={setOpenaiValue}
              pending={pending.openai_api_key === true}
              error={errors.openai_api_key}
              onLink={() => void linkField("openai_api_key", openaiValue)}
              onUnlink={() =>
                unlinkField("openai_api_key", () => setOpenaiValue(""))
              }
            />

            {/* Git token */}
            <CredentialRow
              title="Git"
              description="Link a Git token (e.g. a GitHub personal access token) so the agent can clone and push."
              field="git_token"
              linked={linked.git_token === true}
              value={gitValue}
              onValueChange={setGitValue}
              pending={pending.git_token === true}
              error={errors.git_token}
              onLink={() => void linkField("git_token", gitValue)}
              onUnlink={() => unlinkField("git_token", () => setGitValue(""))}
            />
          </>
        )}
      </div>
    </DetailCard>
  );
}

// ---------------------------------------------------------------------------
// CredentialRow — single labelled secret input with link/unlink + status
// ---------------------------------------------------------------------------

interface CredentialRowProps {
  title: string;
  description: string;
  field: AcpField;
  linked: boolean;
  /** Optional label of the specific linked credential (Claude OAuth vs key). */
  linkedLabel?: string;
  value: string;
  onValueChange: (value: string) => void;
  pending: boolean;
  error?: string;
  onLink: () => void;
  onUnlink: () => void;
  extraControl?: ReactNode;
}

function CredentialRow({
  title,
  description,
  field,
  linked,
  linkedLabel,
  value,
  onValueChange,
  pending,
  error,
  onLink,
  onUnlink,
  extraControl,
}: CredentialRowProps) {
  return (
    <div className="space-y-2 rounded-lg border border-[var(--border-base)] p-4">
      <div className="space-y-1">
        <Typography
          variant="body-medium-default"
          as="p"
          className="text-[var(--content-emphasised)]"
        >
          {title}
        </Typography>
        <Typography
          variant="body-small-default"
          as="p"
          className="text-[var(--content-tertiary)]"
        >
          {description}
        </Typography>
      </div>

      {linked ? (
        <div className="flex items-center justify-between gap-2">
          <span className="flex items-center gap-2 text-body-small-default text-[var(--system-positive-strong)]">
            <CircleCheck className="h-4 w-4 shrink-0" />
            {linkedLabel ?? FIELD_LABEL[field]} linked
          </span>
          <Button variant="dangerGhost" size="compact" onClick={onUnlink}>
            Unlink
          </Button>
        </div>
      ) : (
        <div className="space-y-2">
          {extraControl ? <div className="max-w-[280px]">{extraControl}</div> : null}
          <div className="flex items-start gap-2">
            <Input
              type="password"
              autoComplete="off"
              value={value}
              onChange={(e) => onValueChange(e.target.value)}
              placeholder={`Paste ${FIELD_LABEL[field]}…`}
              aria-label={FIELD_LABEL[field]}
              errorText={error}
              fullWidth
              wrapperClassName="flex-1"
            />
            <Button
              size="compact"
              disabled={pending || !value.trim()}
              onClick={onLink}
            >
              {pending ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                "Link"
              )}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
