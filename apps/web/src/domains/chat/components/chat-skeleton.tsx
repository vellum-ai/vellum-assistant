export function SkeletonBar({ className }: { className?: string }) {
  return (
    <div
      className={`animate-pulse rounded bg-[var(--surface-active)] ${className ?? ""}`}
    />
  );
}

export function ChatSkeleton() {
  return (
    <div className="mx-auto flex w-full max-w-[var(--chat-max-width)] flex-col gap-6 px-4 py-8 sm:px-6">
      {/* User message — right aligned */}
      <div className="flex justify-end">
        <SkeletonBar className="h-4 w-32" />
      </div>

      {/* Assistant response — left aligned, multi-line */}
      <div className="flex flex-col gap-2">
        <SkeletonBar className="h-4 w-3/4" />
        <SkeletonBar className="h-4 w-1/2" />
      </div>

      {/* User message */}
      <div className="flex justify-end">
        <SkeletonBar className="h-4 w-48" />
      </div>

      {/* Assistant response */}
      <div className="flex flex-col gap-2">
        <SkeletonBar className="h-4 w-2/3" />
        <SkeletonBar className="h-4 w-5/6" />
        <SkeletonBar className="h-4 w-1/3" />
      </div>
    </div>
  );
}
