/**
 * Interface for per-channel avatar sync implementations.
 *
 * Each channel that supports bot profile photos implements this interface
 * to push the assistant's avatar PNG to the channel's API.
 */
export interface ChannelAvatarSyncer {
  /** Human-readable channel name for logging. */
  readonly channelName: string;

  /**
   * Push the avatar PNG to this channel's bot profile.
   * Returns true on success, false on failure (failures are logged internally).
   */
  sync(pngBuffer: Buffer): Promise<boolean>;
}
