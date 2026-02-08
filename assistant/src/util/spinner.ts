/**
 * Terminal spinner with elapsed time display.
 * Renders to stderr so it doesn't interfere with stdout content.
 * Silently no-ops when stderr is not a TTY (e.g. redirected to file).
 */

const FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
const DIM = '\x1b[2m';
const RESET = '\x1b[0m';

export class Spinner {
  private message = '';
  private startTime = 0;
  private frameIndex = 0;
  private timer: ReturnType<typeof setInterval> | null = null;
  private active = false;

  start(message: string): void {
    if (!process.stderr.isTTY) return;
    this.stop();
    this.message = message;
    this.startTime = Date.now();
    this.frameIndex = 0;
    this.active = true;
    this.render();
    this.timer = setInterval(() => this.render(), 80);
  }

  stop(): void {
    if (!this.active) return;
    this.active = false;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    // Clear the spinner line
    process.stderr.write('\r\x1b[K');
  }

  private render(): void {
    const frame = FRAMES[this.frameIndex % FRAMES.length];
    this.frameIndex++;
    const elapsed = Math.floor((Date.now() - this.startTime) / 1000);
    const timeStr = elapsed > 0 ? ` (${elapsed}s)` : '';
    process.stderr.write(`\r\x1b[K${DIM}${frame} ${this.message}${timeStr}${RESET}`);
  }
}
