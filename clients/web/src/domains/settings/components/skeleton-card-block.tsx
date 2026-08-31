import { Card, Skeleton } from "@vellumai/design-library";

import { SkeletonLines } from "./skeleton-lines";

export interface SkeletonCardBlockProps {
  className?: string;
  label?: string;
}

export function SkeletonCardBlock({
  className,
  label,
}: SkeletonCardBlockProps) {
  return (
    <Card padding="md" className={className}>
      <Skeleton aria-hidden className="h-5 w-32 rounded-md" />
      <SkeletonLines lines={2} label={label} className="mt-4" />
    </Card>
  );
}
