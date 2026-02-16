export interface ReconcileSourcePlaybook {
  channelId: string;
  content: string;
}

export interface ReconcilePlaybookInput {
  currentChannelId: string;
  currentContent: string;
  sources: ReconcileSourcePlaybook[];
  now?: Date;
}

export interface ReconcilePlaybookResult {
  reconciledContent: string;
  changed: boolean;
  reconciledSteps: string[];
  sourceChannels: string[];
}

const CHECKBOX_LINE = /^- \[( |x|X)\] (.+)$/;

interface ChecklistItem {
  checked: boolean;
  label: string;
}

function normalizeLabel(label: string): string {
  return label
    .toLowerCase()
    .replace(/`/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function parseChecklist(content: string): ChecklistItem[] {
  const items: ChecklistItem[] = [];
  const lines = content.split('\n');
  for (const line of lines) {
    const match = line.match(CHECKBOX_LINE);
    if (!match) continue;
    items.push({
      checked: match[1].toLowerCase() === 'x',
      label: match[2].trim(),
    });
  }
  return items;
}

function appendAuditNote(content: string, sourceChannels: string[], now: Date): string {
  const timestamp = now.toISOString();
  const note = `- ${timestamp}: auto-reconciled from channels: ${sourceChannels.join(', ')}`;
  const marker = '## Reconciliation Audit';
  if (!content.includes(marker)) {
    return `${content.trim()}\n\n${marker}\n${note}\n`;
  }

  const lines = content.split('\n');
  const markerIndex = lines.findIndex((line) => line.trim() === marker);
  if (markerIndex === -1) return `${content.trim()}\n\n${marker}\n${note}\n`;

  const next = [...lines];
  next.splice(markerIndex + 1, 0, note);
  return `${next.join('\n').trim()}\n`;
}

export function reconcilePlaybook(input: ReconcilePlaybookInput): ReconcilePlaybookResult {
  if (input.sources.length === 0) {
    return {
      reconciledContent: input.currentContent,
      changed: false,
      reconciledSteps: [],
      sourceChannels: [],
    };
  }

  const completedLabels = new Map<string, string>();
  for (const source of input.sources) {
    const sourceItems = parseChecklist(source.content);
    for (const item of sourceItems) {
      if (!item.checked) continue;
      completedLabels.set(normalizeLabel(item.label), source.channelId);
    }
  }

  const lines = input.currentContent.split('\n');
  const reconciledSteps: string[] = [];
  const sourceChannels = new Set<string>();
  let changed = false;

  for (let i = 0; i < lines.length; i++) {
    const match = lines[i].match(CHECKBOX_LINE);
    if (!match) continue;
    const checked = match[1].toLowerCase() === 'x';
    if (checked) continue;

    const label = match[2].trim();
    const normalized = normalizeLabel(label);
    const sourceChannel = completedLabels.get(normalized);
    if (!sourceChannel) continue;

    lines[i] = `- [x] ${label}`;
    reconciledSteps.push(label);
    sourceChannels.add(sourceChannel);
    changed = true;
  }

  let reconciledContent = lines.join('\n');
  if (changed) {
    reconciledContent = appendAuditNote(
      reconciledContent,
      Array.from(sourceChannels.values()).sort(),
      input.now ?? new Date(),
    );
  }

  return {
    reconciledContent,
    changed,
    reconciledSteps,
    sourceChannels: Array.from(sourceChannels.values()).sort(),
  };
}
