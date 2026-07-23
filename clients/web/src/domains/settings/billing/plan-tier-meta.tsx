import { AvatarRenderer } from "@/components/avatar-renderer";
import { useBundledAvatarComponents } from "@/utils/use-bundled-avatar-components";

/** Pro package tier keys, keyed by `ProPackage.key` ("free" is the base plan). */
export type PlanTierKey = "free" | "mighty" | "super" | "ultra";

/** Accent color per Pro package tier, keyed by `ProPackage.key` ("free" for the base plan). */
export const TIER_ACCENT: Record<string, string> = {
    free: "#E9C91A",
    mighty: "#4C9B50",
    super: "#0E9B8B",
    ultra: "#EF4300",
};

/** Vellum creature traits per plan tier, matching the pricing-page creatures. */
export const TIER_TRAITS: Record<
    string,
    { bodyShape: string; eyeStyle: string; color: string }
> = {
    free: { bodyShape: "ninja", eyeStyle: "angry", color: "yellow" },
    mighty: { bodyShape: "blob", eyeStyle: "grumpy", color: "green" },
    super: { bodyShape: "urchin", eyeStyle: "goofy", color: "teal" },
    ultra: { bodyShape: "sprout", eyeStyle: "curious", color: "orange" },
};

/**
 * Storage included with the free/base plan. The plan catalog's BasePlan entry
 * carries no storage field, so the baseline comes from the pricing spec
 * (Free = 4 GiB).
 */
export const FREE_STORAGE_GIB = 4;

/**
 * Monthly included credits ($USD) for the free/base plan. The plan catalog's
 * BasePlan entry carries no credits field, so this is the baseline the plan
 * card shows on the current-plan chip for a free user.
 * TODO(confirm): verify the product-correct free credit grant (may be $0).
 */
export const FREE_CREDITS_USD = 0;

/**
 * Vellum creature avatar for a plan tier. The ~48 kB bundled component payload
 * loads lazily; a same-size placeholder holds the layout until it resolves.
 */
export function PlanTierAvatar({
    tier,
    size = 40,
}: {
    tier: string;
    size?: number;
}) {
    const traits = TIER_TRAITS[tier] ?? TIER_TRAITS.free;
    const components = useBundledAvatarComponents();
    return (
        <div aria-hidden className="inline-flex shrink-0">
            {components ? (
                <AvatarRenderer
                    components={components}
                    bodyShapeId={traits.bodyShape}
                    eyeStyleId={traits.eyeStyle}
                    colorId={traits.color}
                    size={size}
                />
            ) : (
                <div style={{ width: size, height: size }} />
            )}
        </div>
    );
}
