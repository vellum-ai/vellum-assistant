import { cn } from "@/utils/misc";

interface PageProgressProps {
  current: number;
  total: number;
}

export function PageProgress({ current, total }: PageProgressProps) {
  return (
    <div className="mb-4 flex items-center gap-1.5">
      {Array.from({ length: total }, (_, i) => (
        // The unfilled track uses --border-subtle (not a surface token): it's
        // the lightest token that still reads against the white --surface-lift
        // form card; surface tokens are too pale to show here.
        <div
          key={i}
          className={cn(
            "h-1.5 flex-1 rounded-full transition-colors",
            i <= current
              ? "bg-[var(--primary-base)]"
              : "bg-[var(--border-subtle)]",
          )}
        />
      ))}
    </div>
  );
}
