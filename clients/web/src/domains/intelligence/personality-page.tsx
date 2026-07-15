/**
 * The personality page — drilled into from the assistant overview. Same
 * avatar-tinted stage (eyes peeking from the bottom) with the five trait
 * sliders from research onboarding; "Update personality" composes the
 * slider values into the personality system-message and runs it as an
 * identity rewrite turn, so the assistant rewrites its own identity files
 * in the new voice.
 *
 * The dial positions persist in a workspace sidecar
 * (`data/personality-sliders.json`): saved after a successful rewrite,
 * read back to seed the sliders so they reopen where the user left them.
 */

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, Sparkles } from "lucide-react";
import { Fragment, useState } from "react";
import { useNavigate } from "react-router";

import { toast } from "@vellumai/design-library";

import { useActiveAssistantId } from "@/assistant/use-active-assistant-id";
import { useAssistantAvatar } from "@/hooks/use-assistant-avatar";
import { routes } from "@/utils/routes";

import { AssistantStage, useAssistantStage } from "./components/assistant-stage";
import { PersonalitySliderRow } from "./components/personality-slider-row";
import { applyPersonalityUpdate } from "./identity-actions/apply-personality-update";
import {
  PERSONALITY_AXES,
  PERSONALITY_AXIS_DEFAULT,
} from "./identity-actions/personality-axes";
import {
  completeSliderValues,
  fetchPersonalitySliders,
  personalitySlidersQueryKey,
  savePersonalitySliders,
} from "./identity-actions/personality-sliders";
import {
  assistantIdentityDetailsQueryKey,
  useAssistantIdentityDetails,
} from "./use-assistant-identity-details";

export function PersonalityPage() {
  const assistantId = useActiveAssistantId();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { components, traits, customImageUrl } = useAssistantAvatar(assistantId);
  const identityQuery = useAssistantIdentityDetails(assistantId);
  const slidersQuery = useQuery({
    queryKey: personalitySlidersQueryKey(assistantId),
    queryFn: () => fetchPersonalitySliders(assistantId),
  });

  // The saved sidecar seeds the dials; `edits` holds only this visit's
  // unsent drags (null = untouched), so the server copy stays the one
  // source of truth until the user actually moves something.
  const [edits, setEdits] = useState<Record<string, number> | null>(null);
  const [applying, setApplying] = useState(false);
  const values = edits ?? slidersQuery.data ?? {};

  const assistantName = identityQuery.data?.identity?.name || "Assistant";

  const handleUpdate = () => {
    setApplying(true);
    const complete = completeSliderValues(values);
    void applyPersonalityUpdate({
      assistantId,
      values: complete,
      assistantName: identityQuery.data?.identity?.name,
    }).then(async (ok) => {
      setApplying(false);
      if (ok) {
        await savePersonalitySliders(assistantId, complete);
        void queryClient.invalidateQueries({
          queryKey: personalitySlidersQueryKey(assistantId),
        });
        void queryClient.invalidateQueries({
          queryKey: assistantIdentityDetailsQueryKey(assistantId),
        });
        toast.success("Personality updated — come say hi!");
        void navigate(routes.identity);
      } else {
        toast.error("The personality update didn't go through. Please try again.");
      }
    });
  };

  return (
    <AssistantStage
      components={components}
      traits={traits}
      customImageUrl={customImageUrl}
      entrance
    >
      <PersonalityBody
        assistantName={assistantName}
        values={values}
        onValueChange={(axisId, value) =>
          setEdits({ ...values, [axisId]: value })
        }
        applying={applying}
        onUpdate={handleUpdate}
        onBack={() => void navigate(routes.identity)}
      />
    </AssistantStage>
  );
}

/**
 * Foreground column of the personality stage. Private to
 * `PersonalityPage`; split only so it can read the stage tone/reserve from
 * context (it must render inside `AssistantStage`).
 */
function PersonalityBody({
  assistantName,
  values,
  onValueChange,
  applying,
  onUpdate,
  onBack,
}: {
  assistantName: string;
  values: Record<string, number>;
  onValueChange: (axisId: string, value: number) => void;
  applying: boolean;
  onUpdate: () => void;
  onBack: () => void;
}) {
  const { tone, bottomReserve } = useAssistantStage();
  const washClasses = tone.isLight
    ? "bg-black/10 hover:bg-black/20"
    : "bg-white/10 hover:bg-white/20";

  return (
    <>
      <button
        type="button"
        onClick={onBack}
        className={`absolute top-4 left-4 z-20 flex cursor-pointer items-center gap-1.5 rounded-full py-2 pr-4 pl-3 text-body-medium-default backdrop-blur-sm transition-all duration-150 active:scale-[0.97] ${washClasses}`}
        style={{ color: tone.fg }}
      >
        <ArrowLeft className="h-4 w-4" aria-hidden />
        Back
      </button>

      <div
        className="flex min-h-0 flex-1 flex-col items-center overflow-y-auto px-6"
        style={{ paddingBottom: bottomReserve }}
      >
        <div className="w-full min-h-14 shrink-[4]" style={{ flexBasis: "12%" }} />

        <div className="flex shrink-0 flex-col items-center gap-2 text-center">
          <h1
            className="text-[2.6rem] leading-none max-sm:text-[2rem]"
            style={{ fontFamily: "var(--font-serif)" }}
          >
            Shape my personality
          </h1>
          <p
            className="max-w-md text-[15px]"
            style={{ color: tone.fgMuted }}
          >
            Slide the dials, then hit update — I&rsquo;ll rewrite myself to
            match.
          </p>
        </div>

        <div className="w-full min-h-3 shrink-[2] basis-10" />

        <div className="flex w-full max-w-2xl shrink-0 flex-col">
          {PERSONALITY_AXES.map((axis, i) => (
            <Fragment key={axis.id}>
              {i > 0 && (
                <div className="w-full min-h-2.5 shrink basis-8 sm:basis-11" />
              )}
              <PersonalitySliderRow
                axis={axis}
                value={values[axis.id] ?? PERSONALITY_AXIS_DEFAULT}
                onValueChange={(next) => onValueChange(axis.id, next)}
                tone={tone}
                disabled={applying}
              />
            </Fragment>
          ))}
        </div>

        <div className="w-full min-h-3 shrink-[2] basis-12" />

        <button
          type="button"
          onClick={onUpdate}
          disabled={applying}
          className="flex h-11 w-[240px] shrink-0 cursor-pointer items-center justify-center gap-2 rounded-[10px] text-body-medium-default transition-transform duration-150 active:scale-[0.97] disabled:cursor-default disabled:opacity-80 disabled:active:scale-100"
          style={{
            backgroundColor: tone.isLight ? "#1A1A1A" : "#FFFFFF",
            color: tone.isLight ? "#FFFFFF" : "#1A1A1A",
          }}
        >
          {applying ? (
            <>
              <div
                className="h-4 w-4 animate-spin rounded-full border-2 border-transparent"
                style={{
                  borderTopColor: tone.isLight ? "#FFFFFF" : "#1A1A1A",
                  borderRightColor: tone.isLight ? "#FFFFFF" : "#1A1A1A",
                }}
              />
              {assistantName} is rewriting itself…
            </>
          ) : (
            <>
              <Sparkles className="h-4 w-4" aria-hidden />
              Update personality
            </>
          )}
        </button>
      </div>
    </>
  );
}
