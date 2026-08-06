import { type LucideIcon } from "lucide-react";
import { type ReactNode } from "react";

import { Card } from "@vellumai/design-library";

interface SkillsStateCardProps {
  icon: LucideIcon;
  /** CSS color for the icon; defaults to the tertiary content tone. */
  iconColor?: string;
  title: string;
  subtitle: string;
  /** Optional action row rendered below the subtitle. */
  children?: ReactNode;
}

/**
 * Centered icon + title + subtitle card used for the Skills surface's
 * empty, error, and not-found states.
 */
export function SkillsStateCard({
  icon: Icon,
  iconColor = "var(--content-tertiary)",
  title,
  subtitle,
  children,
}: SkillsStateCardProps) {
  return (
    <Card.Root>
      <Card.Body className="flex flex-col items-center justify-center py-16 text-center">
        <Icon
          className="mb-3 h-8 w-8"
          style={{ color: iconColor }}
          aria-hidden
        />
        <h3
          className="text-title-small"
          style={{ color: "var(--content-default)" }}
        >
          {title}
        </h3>
        <p
          className="mt-1 max-w-sm text-body-medium-lighter"
          style={{ color: "var(--content-tertiary)" }}
        >
          {subtitle}
        </p>
        {children}
      </Card.Body>
    </Card.Root>
  );
}
