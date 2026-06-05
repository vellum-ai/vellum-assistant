import type { Meta, StoryObj } from "@storybook/react-vite";

import {
  fallbackOutcomeChooserSurface,
  fallbackStarterScenarioSurface,
  specificsCardSurface,
} from "./activation-personas";
import { PersonaColumns, SurfacePreview } from "./activation-story-helpers";

/**
 * Moment 1 fallback — "I don't have anything to port." The fallback's job is the
 * same as Port: end with a specifics card; it just gathers the specifics
 * differently. The spec recommends mocking A, C, and D (B deferred — needs
 * motion work). Option D is paragraph-paste with no surface, so it's represented
 * here by the specifics card the paragraph would resolve into (1.4).
 * See activation-moments-visual-spec.md §"Moment 1 fallback".
 */
const meta: Meta = {
  title: "ActivationFlow/Moment1-Fallback",
  parameters: { layout: "padded" },
  decorators: [
    (Story) => (
      <div className="max-w-[1100px]">
        <Story />
      </div>
    ),
  ],
};

export default meta;
type Story = StoryObj;

export const OptionAOutcomeChooser: Story = {
  name: "Option A — Outcome chooser",
  render: () => (
    <PersonaColumns
      render={(p) => (
        <SurfacePreview initialSurface={fallbackOutcomeChooserSurface(p)} />
      )}
    />
  ),
};

export const OptionCStarterScenario: Story = {
  name: "Option C — Starter scenario",
  render: () => (
    <PersonaColumns
      render={(p) => (
        <SurfacePreview initialSurface={fallbackStarterScenarioSurface(p)} />
      )}
    />
  ),
};

export const OptionDParagraphResult: Story = {
  name: "Option D — Paragraph paste resolves to specifics",
  render: () => (
    <PersonaColumns
      render={(p) => (
        <div className="flex flex-col gap-2">
          <div className="rounded-lg border border-dashed border-[var(--border-element)] bg-[var(--surface-base)] p-3 text-body-small-default text-[var(--content-quiet)]">
            “Tell me about what you’re working on — same kind of thing you’d
            paste into {p.priorAssistant} to get it up to speed. A paragraph or
            two is plenty.” <span className="italic">(chat input is the surface)</span>
          </div>
          <SurfacePreview initialSurface={specificsCardSurface(p, 3)} />
        </div>
      )}
    />
  ),
};
