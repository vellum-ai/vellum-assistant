import { useState } from "react";
import { useNavigate, useSearchParams } from "react-router";

import { OnboardingLayout } from "@/domains/onboarding/components/onboarding-layout";
import {
  DEFAULT_ONBOARDING_PROVIDER,
  ONBOARDING_PROVIDERS,
  defaultModelForOnboardingProvider,
  onboardingProvider,
  type OnboardingProviderId,
} from "@/domains/onboarding/provider-catalog";
import {
  peekPendingProviderKey,
  setPendingProviderKey,
} from "@/domains/onboarding/provider-key";
import { isElectron } from "@/runtime/is-electron";
import { routes } from "@/utils/routes";
import { Button } from "@vellumai/design-library/components/button";
import { Dropdown } from "@vellumai/design-library/components/dropdown";
import { Input } from "@vellumai/design-library/components/input";

import { MOBILE_INPUT_NO_ZOOM } from "@/domains/onboarding/onboarding-step-layout";

export function ApiKeyScreen() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const hosting = searchParams.get("hosting");
  const electron = isElectron();
  const pendingProviderKey = peekPendingProviderKey();

  const [provider, setProvider] = useState<OnboardingProviderId>(
    () => pendingProviderKey?.provider ?? DEFAULT_ONBOARDING_PROVIDER.id,
  );
  const [apiKey, setApiKey] = useState(() => pendingProviderKey?.key ?? "");
  const [model, setModel] = useState(
    () =>
      pendingProviderKey?.model ??
      defaultModelForOnboardingProvider(
        pendingProviderKey?.provider ?? DEFAULT_ONBOARDING_PROVIDER.id,
      ) ??
      "",
  );
  const [baseUrl, setBaseUrl] = useState(
    () => pendingProviderKey?.baseUrl ?? "",
  );
  const [customModels, setCustomModels] = useState(
    () => pendingProviderKey?.customModels ?? "",
  );

  const entry = onboardingProvider(provider) ?? DEFAULT_ONBOARDING_PROVIDER;
  const models = entry.models ?? [];
  const requiresKey = entry.requiresKey;
  const requiresModel = models.length > 0;
  const isOpenAICompatible = provider === "openai-compatible";
  const keyRequired = requiresKey && !isOpenAICompatible;
  const canContinue =
    (!keyRequired || apiKey.trim().length > 0) &&
    (!requiresModel || model.trim().length > 0) &&
    (!isOpenAICompatible ||
      (baseUrl.trim().length > 0 && customModels.trim().length > 0));

  const onContinue = () => {
    if (!canContinue) return;
    const selectedModel =
      model.trim() || defaultModelForOnboardingProvider(provider);
    setPendingProviderKey({
      provider,
      key: apiKey.trim(),
      ...(selectedModel ? { model: selectedModel } : {}),
      ...(isOpenAICompatible
        ? {
            baseUrl: baseUrl.trim(),
            customModels: customModels.trim(),
          }
        : {}),
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
      <div
        className={`mx-auto flex w-full max-w-xl flex-col items-center ${electron ? "min-h-full px-8 pt-21 pb-4 electron-prechat-type" : "px-6 py-16"} text-[var(--content-default)]`}
      >
        <h1
          className={
            electron
              ? "text-title-large"
              : "text-3xl font-semibold tracking-tight"
          }
          style={{ animation: "fadeInUp 0.5s ease-out 0.1s both" }}
        >
          Connect a Model Provider
        </h1>
        <p
          className={`text-center text-body-medium-lighter text-[var(--content-tertiary)] ${electron ? "mt-3.5" : "mt-3"}`}
          style={{ animation: "fadeInUp 0.5s ease-out 0.3s both" }}
        >
          Choose the model provider your assistant should use.
        </p>

        <div
          className={`flex w-full flex-col gap-4 ${electron ? "mt-8" : "mt-10"}`}
          style={{ animation: "fadeInUp 0.5s ease-out 0.4s both" }}
        >
          <div className={`flex flex-col ${electron ? "gap-2" : "gap-1"}`}>
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
                  setModel(defaultModelForOnboardingProvider(match.id) ?? "");
                }
              }}
              options={ONBOARDING_PROVIDERS.map((p) => ({
                value: p.id,
                label: p.displayName,
              }))}
            />
          </div>

          {models.length > 0 && (
            <div className={`flex flex-col ${electron ? "gap-2" : "gap-1"}`}>
              <label className="text-body-small-default text-[var(--content-tertiary)]">
                Model
              </label>
              <Dropdown
                aria-label="Model"
                value={model}
                onChange={setModel}
                options={models.map((option) => ({
                  value: option.id,
                  label: option.displayName,
                }))}
              />
            </div>
          )}

          {isOpenAICompatible && (
            <>
              <div className={`flex flex-col ${electron ? "gap-2" : "gap-1"}`}>
                <label className="text-body-small-default text-[var(--content-tertiary)]">
                  Base URL
                </label>
                <Input
                  type="text"
                  placeholder="http://localhost:1234/v1"
                  value={baseUrl}
                  onChange={(e) => setBaseUrl(e.target.value)}
                  fullWidth
                />
              </div>
              <div className={`flex flex-col ${electron ? "gap-2" : "gap-1"}`}>
                <label className="text-body-small-default text-[var(--content-tertiary)]">
                  Models
                </label>
                <Input
                  type="text"
                  placeholder="model-1, model-2"
                  value={customModels}
                  onChange={(e) => setCustomModels(e.target.value)}
                  fullWidth
                />
                <p className="text-body-small-default text-[var(--content-tertiary)]">
                  Comma-separated model identifiers exposed by your endpoint.
                </p>
              </div>
            </>
          )}

          {requiresKey && (
            <div className="flex flex-col gap-3">
              <Input
                type="password"
                label={`${entry.displayName} API Key`}
                placeholder={entry.apiKeyPlaceholder ?? "Enter your API key"}
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                className={MOBILE_INPUT_NO_ZOOM}
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
          className={`mt-8 flex w-full flex-col ${electron ? "gap-2.5" : "gap-2"}`}
          style={{ animation: "fadeInUp 0.5s ease-out 0.5s both" }}
        >
          <Button
            variant="primary"
            size="regular"
            fullWidth
            disabled={!canContinue}
            onClick={onContinue}
            className={electron ? undefined : "h-11 text-base"}
          >
            Continue
          </Button>
          <Button
            variant="outlined"
            size="regular"
            fullWidth
            onClick={onBack}
            className={electron ? undefined : "h-11 text-base"}
          >
            Back
          </Button>
        </div>
      </div>
    </OnboardingLayout>
  );
}
