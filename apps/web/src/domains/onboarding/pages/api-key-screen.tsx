import { useState } from "react";
import { useNavigate, useSearchParams } from "react-router";

import { Button } from "@vellum/design-library/components/button";
import { Dropdown } from "@vellum/design-library/components/dropdown";
import { Input } from "@vellum/design-library/components/input";
import { OnboardingLayout } from "@/domains/onboarding/components/onboarding-layout";
import {
  DEFAULT_ONBOARDING_PROVIDER,
  onboardingProvider,
  ONBOARDING_PROVIDERS,
  type OnboardingProviderId,
} from "@/domains/onboarding/provider-catalog";
import {
  peekPendingProviderKey,
  setPendingProviderKey,
} from "@/domains/onboarding/provider-key";
import { parseModelIds } from "@/utils/parse-model-ids";
import { routes } from "@/utils/routes";

function isValidHttpUrl(value: string): boolean {
  try {
    const u = new URL(value);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}

export function ApiKeyScreen() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const hosting = searchParams.get("hosting");

  const [provider, setProvider] = useState<OnboardingProviderId>(
    () => peekPendingProviderKey()?.provider ?? DEFAULT_ONBOARDING_PROVIDER.id,
  );
  const [apiKey, setApiKey] = useState(
    () => peekPendingProviderKey()?.key ?? "",
  );
  const [baseUrl, setBaseUrl] = useState(
    () => peekPendingProviderKey()?.baseUrl ?? "",
  );
  const [modelsRaw, setModelsRaw] = useState(() =>
    (peekPendingProviderKey()?.models ?? []).join(", "),
  );

  const entry = onboardingProvider(provider) ?? DEFAULT_ONBOARDING_PROVIDER;
  const requiresKey = entry.requiresKey;
  const isCustom = entry.requiresBaseUrl ?? false;
  const models = parseModelIds(modelsRaw);

  const trimmedBaseUrl = baseUrl.trim();
  const keyOk = !requiresKey || apiKey.trim().length > 0;
  const baseUrlOk = !isCustom || isValidHttpUrl(trimmedBaseUrl);
  const modelsOk = !isCustom || models.length > 0;
  const canContinue = keyOk && baseUrlOk && modelsOk;
  const showBaseUrlError = isCustom && trimmedBaseUrl.length > 0 && !baseUrlOk;

  const onContinue = () => {
    if (!canContinue) return;
    setPendingProviderKey({
      provider,
      key: requiresKey || isCustom ? apiKey.trim() : "",
      ...(isCustom ? { baseUrl: baseUrl.trim(), models } : {}),
    });
    void navigate(
      hosting
        ? `${routes.onboarding.privacy}?hosting=${hosting}`
        : routes.onboarding.privacy,
    );
  };

  const onBack = () => {
    void navigate(routes.onboarding.hosting);
  };

  return (
    <OnboardingLayout>
      <div className="mx-auto flex w-full max-w-xl flex-col items-center px-6 py-16 text-[var(--content-default)]">
        <h1
          className="text-3xl font-semibold tracking-tight"
          style={{ animation: "fadeInUp 0.5s ease-out 0.1s both" }}
        >
          Connect a Model Provider
        </h1>
        <p
          className="mt-3 text-center text-body-medium-lighter text-[var(--content-tertiary)]"
          style={{ animation: "fadeInUp 0.5s ease-out 0.3s both" }}
        >
          Enter an API key to connect your model provider.
        </p>

        <div
          className="mt-10 flex w-full flex-col gap-4"
          style={{ animation: "fadeInUp 0.5s ease-out 0.4s both" }}
        >
          <div className="flex flex-col gap-1">
            <label className="text-body-small-default text-[var(--content-tertiary)]">
              Provider
            </label>
            <Dropdown
              aria-label="Provider"
              value={provider}
              onChange={(v) => {
                const match = onboardingProvider(v);
                if (match) {
                  setProvider(match.id);
                  setApiKey("");
                  setBaseUrl("");
                  setModelsRaw("");
                }
              }}
              options={ONBOARDING_PROVIDERS.map((p) => ({
                value: p.id,
                label: p.displayName,
              }))}
            />
          </div>

          {isCustom && (
            <>
              <div className="flex flex-col gap-1">
                <label className="text-body-small-default text-[var(--content-tertiary)]">
                  Base URL
                </label>
                <Input
                  placeholder="https://api.example.com/v1"
                  value={baseUrl}
                  onChange={(e) => setBaseUrl(e.target.value)}
                  fullWidth
                />
                {showBaseUrlError && (
                  <p className="text-body-small-default text-[var(--content-tertiary)]">
                    Enter a full http(s) URL, e.g. http://localhost:1234/v1
                  </p>
                )}
              </div>
              <div className="flex flex-col gap-1">
                <label className="text-body-small-default text-[var(--content-tertiary)]">
                  Models
                </label>
                <Input
                  placeholder="model-1, model-2"
                  value={modelsRaw}
                  onChange={(e) => setModelsRaw(e.target.value)}
                  fullWidth
                />
                <p className="text-body-small-default text-[var(--content-tertiary)]">
                  Comma-separated model identifiers exposed by your endpoint.
                </p>
              </div>
            </>
          )}

          {(requiresKey || isCustom) && (
            <div className="flex flex-col gap-3">
              <Input
                type="password"
                label={
                  isCustom && !requiresKey
                    ? `${entry.displayName} API Key (optional)`
                    : `${entry.displayName} API Key`
                }
                placeholder={entry.apiKeyPlaceholder ?? "Enter your API key"}
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                fullWidth
              />
              {entry.docsUrl && (
                <p className="self-start text-body-medium-lighter text-[var(--content-tertiary)]">
                  Don't have it?{" "}
                  <a
                    href={entry.docsUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="text-[var(--content-default)] underline"
                  >
                    Get an API key here
                  </a>
                </p>
              )}
            </div>
          )}
        </div>

        <div
          className="mt-8 flex w-full flex-col gap-2"
          style={{ animation: "fadeInUp 0.5s ease-out 0.5s both" }}
        >
          <Button
            variant="primary"
            size="regular"
            fullWidth
            disabled={!canContinue}
            onClick={onContinue}
            className="h-11 text-base"
          >
            Continue
          </Button>
          <Button
            variant="outlined"
            size="regular"
            fullWidth
            onClick={onBack}
            className="h-11 text-base"
          >
            Back
          </Button>
        </div>
      </div>
    </OnboardingLayout>
  );
}
