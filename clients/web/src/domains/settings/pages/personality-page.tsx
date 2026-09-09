/**
 * Settings → Personality. Gated by `vellum-hosted-inference`. Writes
 * `data/personality-sliders.json` and nothing else: no IDENTITY.md / SOUL.md
 * rewrite. Onboarding and About Assistant keep their own rewrite paths.
 */

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Navigate } from "react-router";

import { Button } from "@vellumai/design-library/components/button";
import { Slider } from "@vellumai/design-library/components/slider";
import { toast } from "@vellumai/design-library/components/toast";

import { PERSONALITY_AXIS_IDS } from "@vellumai/assistant-api";

import {
  completeSliderValues,
  fetchPersonalitySliders,
  personalitySlidersQueryKey,
  PERSONALITY_SLIDER_DEFAULT,
  savePersonalitySliders,
} from "@/assistant/personality-sliders";
import { useActiveAssistantId } from "@/assistant/use-active-assistant-id";
import { DetailCard } from "@/components/detail-card";
import { useTranslation } from "@/i18n";
import { useAssistantFeatureFlagStore } from "@/stores/assistant-feature-flag-store";
import { routes } from "@/utils/routes";

const PERSONALITY_AXES = [
  {
    id: PERSONALITY_AXIS_IDS.companionCoworker,
    leftKey: "personalityPage.axes.companionCoworker.left",
    rightKey: "personalityPage.axes.companionCoworker.right",
  },
  {
    id: PERSONALITY_AXIS_IDS.genzBoomer,
    leftKey: "personalityPage.axes.genzBoomer.left",
    rightKey: "personalityPage.axes.genzBoomer.right",
  },
  {
    id: PERSONALITY_AXIS_IDS.executeCollaborate,
    leftKey: "personalityPage.axes.executeCollaborate.left",
    rightKey: "personalityPage.axes.executeCollaborate.right",
  },
  {
    id: PERSONALITY_AXIS_IDS.playfulSerious,
    leftKey: "personalityPage.axes.playfulSerious.left",
    rightKey: "personalityPage.axes.playfulSerious.right",
  },
  {
    id: PERSONALITY_AXIS_IDS.politeUnfiltered,
    leftKey: "personalityPage.axes.politeUnfiltered.left",
    rightKey: "personalityPage.axes.politeUnfiltered.right",
  },
] as const;

export function SettingsPersonalityPage() {
  const { t } = useTranslation("settings");
  const assistantId = useActiveAssistantId();
  const queryClient = useQueryClient();
  const vellumHostedInference =
    useAssistantFeatureFlagStore.use.vellumHostedInference();
  const hasHydrated = useAssistantFeatureFlagStore.use.hasHydrated();

  const slidersQuery = useQuery({
    queryKey: personalitySlidersQueryKey(assistantId),
    queryFn: () => fetchPersonalitySliders(assistantId),
  });

  const [edits, setEdits] = useState<Record<string, number> | null>(null);
  const [saving, setSaving] = useState(false);
  const values = edits ?? slidersQuery.data ?? {};

  if (hasHydrated && !vellumHostedInference) {
    return <Navigate replace to={routes.settings.general} />;
  }

  const handleSave = () => {
    setSaving(true);
    const complete = completeSliderValues(values);
    void savePersonalitySliders(assistantId, complete).then((ok) => {
      setSaving(false);
      if (ok) {
        void queryClient.invalidateQueries({
          queryKey: personalitySlidersQueryKey(assistantId),
        });
        toast.success(t("personalityPage.saveSuccessToast"));
      } else {
        toast.error(t("personalityPage.saveErrorToast"));
      }
    });
  };

  const disabled = saving || slidersQuery.isLoading;

  return (
    <div data-slot="personality-page" className="space-y-6">
      <DetailCard
        title={t("personalityPage.title")}
        subtitle={t("personalityPage.subtitle")}
      >
        {slidersQuery.isError ? (
          <p className="text-body-medium-default text-[var(--content-tertiary)]">
            {t("personalityPage.loadError")}
          </p>
        ) : (
          <div className="flex flex-col gap-6">
            {PERSONALITY_AXES.map((axis) => {
              const left = t(axis.leftKey);
              const right = t(axis.rightKey);
              return (
                <div key={axis.id} className="flex flex-col gap-2">
                  <div className="flex items-center justify-between gap-3 text-body-small-default text-[var(--content-tertiary)]">
                    <span>{left}</span>
                    <span>{right}</span>
                  </div>
                  <Slider
                    value={values[axis.id] ?? PERSONALITY_SLIDER_DEFAULT}
                    onValueChange={(next) => {
                      if (typeof next === "number") {
                        setEdits({ ...values, [axis.id]: next });
                      }
                    }}
                    min={0}
                    max={100}
                    step={1}
                    disabled={disabled}
                    aria-label={t("personalityPage.rangeAriaLabel", {
                      left,
                      right,
                    })}
                  />
                </div>
              );
            })}
          </div>
        )}
      </DetailCard>
      <Button onClick={handleSave} disabled={disabled || slidersQuery.isError}>
        {saving ? t("personalityPage.saving") : t("personalityPage.save")}
      </Button>
    </div>
  );
}
