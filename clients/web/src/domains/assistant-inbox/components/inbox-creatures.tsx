import { AvatarRenderer } from "@/components/avatar-renderer";
import { useBundledAvatarComponents } from "@/utils/use-bundled-avatar-components";

interface CreaturePlacement {
  bodyShape: string;
  eyeStyle: string;
  color: string;
  size: number;
  /** Absolute-position classes; negative offsets clip at the card edge. */
  position: string;
  rotate: number;
}

/**
 * The three creatures the email onboarding card hangs off its top edge: a
 * yellow star upside down on the left corner, an orange star past centre,
 * and a heavy-lidded green blob looking in from the right.
 */
const TOP_PLACEMENTS: CreaturePlacement[] = [
  {
    bodyShape: "star",
    eyeStyle: "curious",
    color: "yellow",
    size: 103,
    position: "-left-[28px] -top-[33px]",
    rotate: 180,
  },
  {
    bodyShape: "star",
    eyeStyle: "curious",
    color: "orange",
    size: 109,
    position: "left-[63%] -top-[62px] -translate-x-1/2",
    rotate: -8,
  },
  {
    bodyShape: "blob",
    eyeStyle: "grumpy",
    color: "green",
    size: 76,
    position: "-right-[25px] top-[60px]",
    rotate: 1,
  },
];

/** Two more around the bottom for the upgrade card, which has room to spare. */
const AROUND_PLACEMENTS: CreaturePlacement[] = [
  ...TOP_PLACEMENTS,
  /* Both keep to the card's lower-left, which the right-aligned actions
     leave empty, so neither sits behind a button or a line of copy. */
  {
    bodyShape: "stack",
    eyeStyle: "gentle",
    color: "purple",
    size: 92,
    position: "-left-[38px] -bottom-[30px]",
    rotate: 8,
  },
  {
    bodyShape: "sprout",
    eyeStyle: "curious",
    color: "pink",
    size: 64,
    position: "left-[24%] -bottom-[20px]",
    rotate: -6,
  },
];

export interface InboxCreaturesProps {
  variant?: "top" | "around";
}

/**
 * Decorative creatures scattered over a card's edges, clipped by the card's
 * `overflow-hidden`. Renders nothing until the avatar chunk resolves, and
 * nothing a screen reader needs.
 */
export function InboxCreatures({ variant = "top" }: InboxCreaturesProps) {
  const components = useBundledAvatarComponents();
  if (!components) {
    return null;
  }
  const placements = variant === "top" ? TOP_PLACEMENTS : AROUND_PLACEMENTS;

  return (
    <div
      aria-hidden="true"
      data-testid="inbox-creatures"
      className="pointer-events-none absolute inset-0 select-none"
    >
      {placements.map((creature, index) => (
        <span
          key={index}
          className={`absolute ${creature.position}`}
          style={{ rotate: `${creature.rotate}deg` }}
        >
          <AvatarRenderer
            components={components}
            bodyShapeId={creature.bodyShape}
            eyeStyleId={creature.eyeStyle}
            colorId={creature.color}
            size={creature.size}
          />
        </span>
      ))}
    </div>
  );
}
