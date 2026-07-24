import {
  isCompletePrivateKeyBlock,
  PRIVATE_KEY_LABEL,
  type DetectedSecret,
} from "@vellumai/service-contracts/secret-detection";

import { AddCredentialModal } from "@/components/add-credential-modal";
import { useComposerStore } from "@/domains/chat/composer-store";

/** Vault slot (service + field) a detected secret is stored under. */
export interface CredentialSlot {
  service: string;
  field: string;
}

const UNKNOWN_SLOT: CredentialSlot = { service: "", field: "" };

/**
 * Suggested vault slot per detection label from the shared secret-detection
 * patterns (`@vellumai/service-contracts/secret-detection`). Labels without
 * an entry — including the token-shape label and "Private Key", where the
 * owning service is unknowable — fall back to empty fields for the user to
 * fill in. Suggestions only; every field stays editable in the dialog.
 */
const SLOT_BY_DETECTION_LABEL: Record<string, CredentialSlot> = {
  "AWS Access Key": { service: "aws", field: "access_key_id" },
  "GitHub Token": { service: "github", field: "token" },
  "GitHub Fine-Grained PAT": { service: "github", field: "token" },
  "GitLab Token": { service: "gitlab", field: "token" },
  "Stripe Secret Key": { service: "stripe", field: "secret_key" },
  "Stripe Restricted Key": { service: "stripe", field: "restricted_key" },
  "Slack Bot Token": { service: "slack", field: "bot_token" },
  "Slack User Token": { service: "slack", field: "user_token" },
  "Slack App Token": { service: "slack", field: "app_token" },
  "Telegram Bot Token": { service: "telegram", field: "bot_token" },
  "Anthropic API Key": { service: "anthropic", field: "api_key" },
  "OpenAI API Key": { service: "openai", field: "api_key" },
  "OpenAI Project Key": { service: "openai", field: "api_key" },
  "Google API Key": { service: "google", field: "api_key" },
  "Google OAuth Client Secret": {
    service: "google",
    field: "oauth_client_secret",
  },
  "Twilio API Key": { service: "twilio", field: "api_key" },
  "SendGrid API Key": { service: "sendgrid", field: "api_key" },
  "Mailgun API Key": { service: "mailgun", field: "api_key" },
  "npm Token": { service: "npm", field: "token" },
  "PyPI API Token": { service: "pypi", field: "api_token" },
  "Linear API Key": { service: "linear", field: "api_key" },
  "Notion Integration Token": {
    service: "notion",
    field: "integration_token",
  },
  "OpenRouter API Key": { service: "openrouter", field: "api_key" },
  "Vercel AI Gateway API Key": {
    service: "vercel",
    field: "ai_gateway_api_key",
  },
  "Fireworks API Key": { service: "fireworks", field: "api_key" },
  "Perplexity API Key": { service: "perplexity", field: "api_key" },
  "Tavily API Key": { service: "tavily", field: "api_key" },
  "Firecrawl API Key": { service: "firecrawl", field: "api_key" },
};

/**
 * Maps an internal detection label (e.g. "OpenAI API Key") to the vault slot
 * the dialog pre-fills. Unknown labels yield empty strings.
 */
export function suggestCredentialSlot(label: string): CredentialSlot {
  return SLOT_BY_DETECTION_LABEL[label] ?? UNKNOWN_SLOT;
}

/**
 * True when storing this secret and rewriting the draft removes the entire
 * secret. A `Private Key` match whose value lacks the PEM END footer is only
 * the block header (the footer is absent from the draft — truncated or
 * partial paste): storing it would vault the header alone and the rewrite
 * would strip just the header, leaving the key body in the composer with
 * nothing left for the detector to flag. Such a match must not be offered
 * the "Store securely" action.
 */
export function isStorableSecret(secret: DetectedSecret): boolean {
  return (
    secret.label !== PRIVATE_KEY_LABEL ||
    isCompletePrivateKeyBlock(secret.value)
  );
}

/**
 * Replaces every occurrence of a stored secret in the draft with a plaintext
 * placeholder naming its vault slot. The placeholder is model-actionable: the
 * assistant discovers stored credentials via `assistant credentials list` and
 * uses them through `credential_ids` on proxied tools.
 */
export function rewriteDraftWithStoredCredential(
  draft: string,
  secretValue: string,
  slot: CredentialSlot,
): string {
  return draft.replaceAll(
    secretValue,
    `[stored securely as ${slot.service}/${slot.field}]`,
  );
}

export interface StoreCredentialDialogProps {
  /** The detected secret being stored; seeds the form when the dialog opens. */
  secret: DetectedSecret | null;
  open: boolean;
  /** Called when the dialog closes — dismissal, Cancel, or a completed save. */
  onClose: () => void;
  /**
   * Called after the credential is saved and the draft rewrite has been
   * applied to the composer store.
   */
  onStored: (slot: CredentialSlot) => void;
}

/**
 * "Store securely" flow for a secret detected in the chat draft: wraps the
 * shared {@link AddCredentialModal} pre-filled with the detected value
 * (password input — never echoed as plaintext) and a service/field
 * suggestion derived from the detection label. On save it rewrites the
 * composer draft, replacing the secret with its vault-slot placeholder, so
 * the plaintext key never enters the transcript. Cancel leaves the draft —
 * and the composer secret notice — untouched.
 *
 * Never opens for a non-{@link isStorableSecret} match (a header-only
 * private key): storing it would rewrite only the header and leave the key
 * body in the draft, undetected.
 */
export function StoreCredentialDialog({
  secret,
  open,
  onClose,
  onStored,
}: StoreCredentialDialogProps) {
  const suggestion = suggestCredentialSlot(secret?.label ?? "");
  const storable = secret !== null && isStorableSecret(secret);

  const handleSaved = (meta: { service: string; field: string }) => {
    if (!secret || !isStorableSecret(secret)) {
      return;
    }
    const slot: CredentialSlot = { service: meta.service, field: meta.field };
    const { input, setInput } = useComposerStore.getState();
    setInput(rewriteDraftWithStoredCredential(input, secret.value, slot));
    onStored(slot);
  };

  return (
    <AddCredentialModal
      open={open && storable}
      onClose={onClose}
      onSaved={handleSaved}
      successToastMessage="Stored securely — the key never entered the chat"
      initialValues={{
        service: suggestion.service,
        field: suggestion.field,
        value: secret?.value ?? "",
      }}
    />
  );
}
