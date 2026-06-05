import type { Meta, StoryObj } from "@storybook/react-vite";
import { useMemo, useState } from "react";

import {
  PERSONA_MEMORY_GRAPHS,
  conceptPageRevealedSlugs,
  conceptPagesToGraph,
} from "./memory-graph-data";
import { MemoryGraphView } from "./memory-graph-view";

/**
 * Knowledge Web — the assistant's model of YOU, drawn from the MemoryV2
 * concept-page graph: real ConceptPages (slug + summary) connected by their real
 * directed frontmatter links. Click a node for its details; click a link to
 * highlight it. JARVIS-1112.
 *
 * Buildable with NO backend changes: the nodes come from the existing
 * `memory_v2_list_concept_pages` endpoint and the edges from
 * `memory_v2_get_concept_page` (the `edges` in each page's frontmatter), assembled
 * client-side. A dedicated graph endpoint would only collapse the N+1 fetch — it
 * isn't required. The one forward-looking part is timing: pages are written by
 * the hourly consolidation job, so the graph populates after consolidation, not
 * live per-turn during the first conversation.
 */
const meta: Meta = {
  title: "ActivationFlow/KnowledgeWeb",
  parameters: { layout: "padded" },
  decorators: [
    (Story) => (
      <div className="max-w-[900px]">
        <Story />
      </div>
    ),
  ],
};

export default meta;
type Story = StoryObj;

/** The full model-of-you web. */
export const ModelOfYou: Story = {
  name: "Model of you",
  render: () => (
    <div className="flex flex-col gap-2">
      <div className="h-[560px] w-full max-w-[820px]">
        <MemoryGraphView
          data={conceptPagesToGraph(PERSONA_MEMORY_GRAPHS.porter!)}
        />
      </div>
      <p className="max-w-[820px] text-body-small-default text-[var(--content-tertiary)]">
        Real today, no backend changes: nodes from{" "}
        <code>memory_v2_list_concept_pages</code>, edges from each page's
        frontmatter via <code>memory_v2_get_concept_page</code>, assembled
        client-side.
      </p>
    </div>
  ),
};

const MOMENT_LABEL: Record<0 | 1 | 2 | 3 | 4, string> = {
  0: "Hatched",
  1: "Port",
  2: "Propose",
  3: "Run",
  4: "Follow-through",
};

/** The web filling in across the activation rail over stable positions. */
function GrowingConceptGraph({ graphKey }: { graphKey: string }) {
  const graph = PERSONA_MEMORY_GRAPHS[graphKey]!;
  // Full graph laid out ONCE → stable positions; only the revealed set changes.
  const data = useMemo(() => conceptPagesToGraph(graph), [graph]);
  const [moment, setMoment] = useState<0 | 1 | 2 | 3 | 4>(0);
  const revealed = useMemo(
    () => conceptPageRevealedSlugs(graph, moment),
    [graph, moment],
  );
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-label-small-default uppercase tracking-wide text-[var(--content-tertiary)]">
          Moment
        </span>
        {([0, 1, 2, 3, 4] as const).map((m) => (
          <button
            key={m}
            type="button"
            onClick={() => setMoment(m)}
            className={[
              "rounded-md px-3 py-1 text-body-small-default transition-colors",
              moment === m
                ? "bg-[var(--primary-base)] text-[var(--content-inset)]"
                : "border border-[var(--border-element)] bg-[var(--surface-base)] text-[var(--content-secondary)] hover:bg-[var(--surface-hover)]",
            ].join(" ")}
          >
            {MOMENT_LABEL[m]}
          </button>
        ))}
      </div>
      <div className="h-[560px] w-full max-w-[820px]">
        <MemoryGraphView data={data} revealedIds={revealed} />
      </div>
      <p className="max-w-[820px] text-body-small-default text-[var(--content-tertiary)]">
        Step the moments: the assistant’s model of you fills in over stable
        positions as the conversation advances. Propose adds nothing — it’s output,
        not new memory. Nodes/edges come from today’s{" "}
        <code>list-concept-pages</code> + <code>get-concept-page</code> (no new
        endpoint); the only forward-looking part is timing — pages are written by
        the hourly consolidation job, so in production the web fills in after
        consolidation, not live per-turn.
      </p>
    </div>
  );
}

export const GrowsAcrossMoments: Story = {
  name: "Grows across moments",
  render: () => <GrowingConceptGraph graphKey="porter" />,
};
