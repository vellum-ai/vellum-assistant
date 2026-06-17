import { CircleCheck } from "lucide-react";

import { Typography } from "@vellumai/design-library/components/typography";

export interface PlanFeatureListProps {
  features: string[];
  /** "inline" joins features as comma-separated text; "checklist" renders with icons. */
  variant: "inline" | "checklist";
  /** Header shown above the checklist variant. Ignored for "inline". */
  header?: string;
  /** Max features to show in "inline" variant. Defaults to 3. */
  maxInline?: number;
}

export function PlanFeatureList({
  features,
  variant,
  header,
  maxInline = 3,
}: PlanFeatureListProps) {
  if (variant === "inline") {
    return <>{features.slice(0, maxInline).join(", ")}</>;
  }

  return (
    <div className="flex flex-col gap-3">
      {header && (
        <Typography
          as="p"
          variant="body-small-default"
          className="text-[var(--content-secondary)]"
        >
          {header}
        </Typography>
      )}
      <ul className="flex flex-col gap-2">
        {features.map((feature) => (
          <li key={feature} className="flex items-start gap-2">
            <CircleCheck
              className="mt-0.5 h-4 w-4 shrink-0 text-[var(--content-tertiary)]"
              aria-hidden
            />
            <Typography as="span" variant="body-medium-default">
              {feature}
            </Typography>
          </li>
        ))}
      </ul>
    </div>
  );
}
