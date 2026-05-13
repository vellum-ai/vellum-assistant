/**
 * Cloud-mode assistant identity bar showing avatar initial, name, and
 * account email. Only rendered when mode is 'cloud'.
 */
export interface AssistantInfoBarProps {
  assistantName: string;
  accountEmail: string;
}

export function AssistantInfoBar({ assistantName, accountEmail }: AssistantInfoBarProps) {
  const initial = assistantName.charAt(0).toUpperCase();

  return (
    <div className="flex items-center gap-2.5 rounded-xl border border-edge bg-surface px-3.5 py-2.5 mb-2.5">
      <div className="flex size-[34px] shrink-0 items-center justify-center rounded-full bg-surface-alt text-sm font-medium text-fg-muted">
        {initial}
      </div>
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium text-fg">{assistantName}</p>
        {accountEmail && (
          <p className="truncate text-xs text-fg-muted">{accountEmail}</p>
        )}
      </div>
    </div>
  );
}
