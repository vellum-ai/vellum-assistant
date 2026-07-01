import { Plug } from "lucide-react";

interface PluginPillProps {
  name: string;
  selected: boolean;
  onToggle: () => void;
}

export function PluginPill({ name, selected, onToggle }: PluginPillProps) {
  return (
    <button
      type="button"
      aria-pressed={selected}
      aria-label={`${selected ? "Disable" : "Enable"} ${name} for this chat`}
      onClick={onToggle}
      className={`inline-flex h-[34px] cursor-pointer items-center gap-1.5 rounded-full border pl-2.5 pr-3 text-body-medium-default ${
        selected
          ? "border-[var(--border-active)] bg-[var(--surface-active)] text-[var(--content-default)]"
          : "border-[var(--border-disabled)] bg-[var(--surface-base)] text-[var(--content-secondary)]"
      }`}
    >
      <Plug className="h-4 w-4 shrink-0" aria-hidden />
      {name}
    </button>
  );
}
