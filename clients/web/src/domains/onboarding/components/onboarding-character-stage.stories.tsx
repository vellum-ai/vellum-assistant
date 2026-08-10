/**
 * The picker's avatar ring: one character centered, the rest cut off around the
 * edges.
 *
 * These stories exist for the geometry. `edgeSize` and `edgeSlots` compute every
 * avatar's size and position from the measured stage box, so the arrangement is
 * only correct relative to a container, and it is different at every container
 * size. Nothing in the running app lets you see it at more than one size at a
 * time, which is how a slot arrangement drifts unnoticed.
 *
 * The stage box is deliberately not a prop. These mount inside the real
 * `OnboardingStage`, the same component the three onboarding screens use, so it
 * measures itself exactly as it does in production. A story that passed a size
 * by hand would be validating its own arithmetic (see LUM-3164).
 */

import type { Meta, StoryObj } from "@storybook/react-vite";

import { OnboardingCharacterStage } from "./onboarding-character-stage";
import { OnboardingStage } from "./onboarding-stage";
import { SeededAvatarPool, StageHost } from "./onboarding-story-fixtures";
import { useOnboardingAvatarPoolStore } from "@/domains/onboarding/onboarding-avatar-pool-store";
import { useBundledAvatarComponents } from "@/utils/use-bundled-avatar-components";

/**
 * The ring as `GiveMeAFaceScreen` arranges it: the stored selection centered,
 * everyone else in an edge slot, at rest (no swap in flight).
 *
 * Renders inside `SeededAvatarPool`, so the pool is guaranteed non-empty here.
 */
function CharacterRing({ centerChar = 0 }: { centerChar?: number }) {
  const components = useBundledAvatarComponents();
  const characters = useOnboardingAvatarPoolStore.use.characters();
  if (!components) {
    return null;
  }

  return (
    <OnboardingCharacterStage
      components={components}
      characters={characters}
      centerChar={centerChar}
      edgeOrder={characters.map((_, i) => i).filter((i) => i !== centerChar)}
      entering={null}
      exiting={null}
      onEnterComplete={() => {}}
      onSelectChar={() => {}}
    />
  );
}

const meta: Meta<typeof OnboardingCharacterStage> = {
  title: "Onboarding/OnboardingCharacterStage",
  parameters: {
    layout: "fullscreen",
    // The ring's inputs are the pool and the measured box, neither of which is
    // a meaningful control; the stories differ by viewport instead.
    controls: { disable: true },
  },
  render: () => (
    <StageHost>
      <OnboardingStage className="bg-[var(--surface-base)] text-[var(--content-default)]">
        <SeededAvatarPool>
          <CharacterRing />
        </SeededAvatarPool>
      </OnboardingStage>
    </StageHost>
  ),
};

export default meta;
type Story = StoryObj<typeof OnboardingCharacterStage>;

/** Desktop: the widest arrangement, where the edge slots spread furthest. */
export const Desktop: Story = {
  globals: { viewport: { value: "sbDesktop" } },
};

/**
 * Phone width, where `edgeSize`'s 130px floor starts to dominate its 40% term
 * and the cast crowds the centered avatar. The arrangement the app ships on
 * mobile, and the case the desktop story cannot show.
 */
export const Mobile: Story = {
  globals: { viewport: { value: "sbMobile" } },
};

/**
 * The stage inset by a notched device's safe area (`root-layout.tsx` is `100dvh`
 * minus `env(safe-area-inset-*)`), measured here as a 390x751 stage inside a
 * 390x844 viewport.
 *
 * The ring reads the stage box, so it stays whole and centered inside the inset
 * frame, clipping at the stage's edges rather than the window's. A layer reading
 * the layout viewport instead would be 93px out, which is the defect LUM-3198
 * describes.
 */
export const InsetByASafeArea: Story = {
  globals: { viewport: { value: "sbMobile" } },
  render: () => (
    // iPhone 15 Pro insets: 59pt status/Dynamic Island, 34pt home indicator.
    <StageHost insetTop={59} insetBottom={34}>
      <OnboardingStage className="bg-[var(--surface-base)] text-[var(--content-default)]">
        <SeededAvatarPool>
          <CharacterRing />
        </SeededAvatarPool>
      </OnboardingStage>
    </StageHost>
  ),
};
