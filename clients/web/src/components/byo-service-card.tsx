import type { ReactNode } from "react";

import { DetailCard } from "@/components/detail-card";

interface ByoServiceCardProps {
  id?: string;
  title: string;
  subtitle: string;
  children: ReactNode;
}

export function ByoServiceCard({
  id,
  title,
  subtitle,
  children,
}: ByoServiceCardProps) {
  return (
    <DetailCard id={id} title={title} subtitle={subtitle}>
      <div className="mt-4">{children}</div>
    </DetailCard>
  );
}
