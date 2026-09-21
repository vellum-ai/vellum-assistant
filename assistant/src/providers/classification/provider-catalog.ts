/**
 * Classification provider catalog: decision models that answer a question
 * about some input with structured output (a probability, a choice, a
 * score) rather than generated chat text.
 *
 * Kept apart from the LLM `PROVIDER_CATALOG` on purpose. A classification
 * model cannot back a conversation or an inference profile, so listing it
 * with the chat models forced every text picker and profile validator to
 * special-case it. Consumers that need a yes/no verdict (the voice judges,
 * the memory pool selector) resolve through `services.classification`
 * instead of an LLM call site.
 */

export type ClassificationProviderId = "typesafe";

/** Guide for obtaining API credentials from a provider. */
export interface ClassificationCredentialsGuide {
  readonly description: string;
  readonly url: string;
  readonly linkLabel: string;
}

export interface ClassificationModelEntry {
  readonly id: string;
  readonly displayName: string;
  /** Published request budget for one classification call. */
  readonly contextWindowTokens: number;
  readonly pricing?: {
    readonly inputPer1mTokens: number;
    readonly outputPer1mTokens: number;
  };
}

export interface ClassificationProviderEntry {
  readonly id: ClassificationProviderId;
  readonly displayName: string;
  readonly subtitle: string;
  readonly setupMode: "api-key";
  readonly setupHint: string;
  /** Credential-store name read by `getProviderKeyAsync` for the BYOK path. */
  readonly credentialProvider: string;
  /** Environment variable honored when no key is stored. */
  readonly envVar: string;
  readonly credentialsGuide: ClassificationCredentialsGuide;
  readonly defaultModel: string;
  readonly models: readonly ClassificationModelEntry[];
  /**
   * Platform runtime-proxy path fronting this provider, when the platform
   * serves it with a Vellum-managed key. Absent means BYOK only.
   */
  readonly managedProxyPath?: string;
}

const CATALOG: readonly ClassificationProviderEntry[] = [
  {
    id: "typesafe",
    displayName: "TypeSafe",
    subtitle:
      "TypeSafe System One decision model. Returns structured answers, not generated text.",
    setupMode: "api-key",
    setupHint: "Enter your TypeSafe API key to enable Jev.",
    credentialProvider: "typesafe",
    envVar: "TYPESAFE_API_KEY",
    credentialsGuide: {
      description: "Sign in to TypeSafe and create an API key.",
      url: "https://typesafe.ai",
      linkLabel: "Open TypeSafe",
    },
    defaultModel: "jev-latest",
    models: [
      {
        id: "jev-latest",
        displayName: "Jev",
        // TypeSafe's published request budget is about 32,000 tokens.
        contextWindowTokens: 32_000,
        pricing: { inputPer1mTokens: 0.042, outputPer1mTokens: 0 },
      },
    ],
    managedProxyPath: "/v1/runtime-proxy/typesafe",
  },
];

export const CLASSIFICATION_PROVIDER_IDS = CATALOG.map((entry) => entry.id) as [
  ClassificationProviderId,
  ...ClassificationProviderId[],
];

export function listClassificationProviderEntries(): readonly ClassificationProviderEntry[] {
  return CATALOG;
}

export function getClassificationProviderEntry(
  id: string,
): ClassificationProviderEntry | undefined {
  return CATALOG.find((entry) => entry.id === id);
}

export function getClassificationModelEntry(
  providerId: string,
  modelId: string,
): ClassificationModelEntry | undefined {
  return getClassificationProviderEntry(providerId)?.models.find(
    (model) => model.id === modelId,
  );
}

/** Credential-store names the BYOK path reads, deduplicated. */
export function listClassificationCredentialProviderNames(): string[] {
  return [...new Set(CATALOG.map((entry) => entry.credentialProvider))];
}

/** Env var backing a credential name, for env-only installs. */
export function classificationEnvVarForCredential(
  credentialProvider: string,
): string | undefined {
  return CATALOG.find(
    (entry) => entry.credentialProvider === credentialProvider,
  )?.envVar;
}
