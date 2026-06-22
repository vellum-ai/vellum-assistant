import { type ReactNode } from "react";

interface AccountShellProps {
  children: ReactNode;
}

export function AccountShell({ children }: AccountShellProps) {
  return (
    <div className="flex min-h-screen items-center justify-center bg-[var(--surface-base)]">
      <div className="w-full max-w-[480px] px-6">
        <div className="flex flex-col items-center gap-10">
          <div className="w-full">{children}</div>
        </div>
      </div>
    </div>
  );
}
