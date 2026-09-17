import type { SubagentParentNotification } from "../subagent/parent-notification.js";

/** A task's newer update supersedes its pending update, independently of other tasks. */
export class VoiceSubagentNotifications {
  private readonly pending = new Map<string, SubagentParentNotification>();
  private playback: {
    notification: SubagentParentNotification;
    untilMs: number;
  } | null = null;

  get hasPending(): boolean {
    return this.pending.size > 0;
  }

  enqueue(notification: SubagentParentNotification): void {
    this.pending.set(notification.taskId, notification);
  }

  next(): SubagentParentNotification | undefined {
    return this.pending.values().next().value;
  }

  finish(
    notification: SubagentParentNotification,
    playbackUntilMs: number,
  ): void {
    this.playback = { notification, untilMs: playbackUntilMs };
  }

  acknowledgePlayback(now: number): void {
    const playback = this.playback;
    if (playback === null || now < playback.untilMs) {
      return;
    }
    const { notification } = playback;
    if (this.pending.get(notification.taskId) === notification) {
      this.pending.delete(notification.taskId);
    }
    this.playback = null;
  }

  interruptPlayback(now: number): void {
    this.acknowledgePlayback(now);
    this.playback = null;
  }

  drain(now: number): SubagentParentNotification[] {
    this.acknowledgePlayback(now);
    const notifications = [...this.pending.values()];
    this.pending.clear();
    this.playback = null;
    return notifications;
  }
}
