import { Check } from "lucide-react";
import { useState } from "react";

import type { QuestionResponseEntry } from "@/domains/chat/api/event-types";
import type { Surface } from "@/domains/chat/types/types";
import type { QuestionEntry } from "@/types/interaction-ui-types";

import { QuestionPromptCard } from "@/domains/chat/components/question-prompt-card";
import { SurfaceRouter } from "./surface-router";
import { ACTIVATION_PERSONAS, type ActivationPersona } from "./activation-personas";

/**
 * Shared rendering helpers for the Activation Moments Storybook spike
 * (JARVIS-1112). Kept out of the persona fixture file so that file can stay
 * pure data (`.ts`, no JSX).
 */

/**
 * Renders a single surface through the real `SurfaceRouter` and collapses it
 * into its completion chip on action — mirroring the optimistic local
 * completion that `handleSurfaceAction` applies in production, so interactive
 * stories show the same before/after the user sees in chat. Surfaces that do
 * not opt into optimistic completion (e.g. `work_result`, `copy_block`) simply
 * fire the action and stay rendered, which is also production-accurate.
 */
export function SurfacePreview({ initialSurface }: { initialSurface: Surface }) {
  const [surface, setSurface] = useState(initialSurface);
  return (
    <SurfaceRouter
      surface={surface}
      onAction={(_surfaceId, actionId, data) => {
        const choiceTitle =
          typeof data?.choiceTitle === "string" ? data.choiceTitle : undefined;
        const matched = surface.actions?.find((a) => a.id === actionId);
        const label = choiceTitle ?? matched?.label ?? actionId;
        setSurface((current) => ({
          ...current,
          completed: true,
          completionSummary: `${label} selected`,
        }));
      }}
    />
  );
}

/** Static (non-interactive) render of a surface, for display-only frames. */
export function StaticSurface({ surface }: { surface: Surface }) {
  return <SurfaceRouter surface={surface} onAction={() => {}} />;
}

/**
 * Renders the assistant's real ask-a-question UI (`QuestionPromptCard`) for a
 * single question, and collapses into a completion chip once answered — the
 * surface the assistant actually shows when it proposes an outcome or offers a
 * follow-through (Moments 2 and 4).
 */
export function QuestionPromptDemo({ entry }: { entry: QuestionEntry }) {
  const [answer, setAnswer] = useState<string | null>(null);

  if (answer) {
    return (
      <div className="flex items-center gap-2 rounded-lg border border-[var(--system-positive-strong)] bg-[var(--system-positive-weak)] px-3 py-2 text-body-medium-lighter text-[var(--system-positive-strong)]">
        <Check className="h-4 w-4 shrink-0" />
        {answer}
      </div>
    );
  }

  return (
    <QuestionPromptCard
      requestId="story"
      entries={[entry]}
      isSubmitting={false}
      onSubmitAll={(responses: QuestionResponseEntry[]) => {
        const r = responses[0];
        let label = "Answered";
        if (r?.kind === "option") {
          label = entry.options.find((o) => o.id === r.optionId)?.label ?? label;
        } else if (r?.kind === "free_text") {
          label = r.text;
        } else if (r?.kind === "skip") {
          label = "Skipped";
        }
        setAnswer(label);
      }}
    />
  );
}

/**
 * Lay a render-fn out across both personas, side by side on wide viewports and
 * stacked on narrow ones. The two-persona comparison is the whole point: it's
 * what reveals whether a surface actually personalizes or just looks like it.
 */
export function PersonaColumns({
  render,
}: {
  render: (persona: ActivationPersona) => React.ReactNode;
}) {
  return (
    <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
      {ACTIVATION_PERSONAS.map((persona) => (
        <div key={persona.key} className="flex flex-col gap-2">
          <div className="text-label-small-default uppercase tracking-wide text-[var(--content-tertiary)]">
            {persona.label}
          </div>
          <div className="flex flex-col gap-3">{render(persona)}</div>
        </div>
      ))}
    </div>
  );
}
