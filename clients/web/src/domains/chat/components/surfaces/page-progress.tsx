interface PageProgressProps {
  current: number;
  total: number;
}

export function PageProgress({ current, total }: PageProgressProps) {
  return (
    <div className="mb-4 flex items-center gap-1.5">
      {Array.from({ length: total }, (_, i) => (
        <div
          key={i}
          className={`h-1.5 flex-1 rounded-full transition-colors ${
            i <= current ? "bg-[var(--primary-base)]" : "bg-[var(--border-subtle)]"
          }`}
        />
      ))}
    </div>
  );
}
