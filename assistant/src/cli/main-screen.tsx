const LEFT_PANEL_WIDTH = 36;
const DEFAULT_HEIGHT = 12;

export interface MainScreenLayout {
  height: number;
  statusLine: number;
  statusCol: number;
}

export function renderMainScreen(): MainScreenLayout {
  const height = DEFAULT_HEIGHT;
  const statusCanvasLine = height + 1;
  const statusCol = LEFT_PANEL_WIDTH + 1;

  return { height, statusLine: statusCanvasLine, statusCol };
}

export function updateStatusText(layout: MainScreenLayout, text: string): void {
  process.stdout.write(
    `\x1b7\x1b[${layout.statusLine};${layout.statusCol}H\x1b[K${text}\x1b8`,
  );
}

export function updateDaemonText(layout: MainScreenLayout, text: string): void {
  const daemonLine = layout.statusLine - 4;
  process.stdout.write(
    `\x1b7\x1b[${daemonLine};${layout.statusCol}H\x1b[K\x1b[35m${text}\x1b[0m\x1b8`,
  );
}
