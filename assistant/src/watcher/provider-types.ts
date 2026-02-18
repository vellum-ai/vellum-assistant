/** A single event detected by a watcher provider. */
export interface WatcherItem {
  /** Provider-specific dedup key (e.g. Gmail message ID). */
  externalId: string;
  /** Event category (e.g. 'new_email'). */
  eventType: string;
  /** One-line human-readable summary. */
  summary: string;
  /** Full event data for LLM processing. */
  payload: Record<string, unknown>;
  /** When the event occurred (epoch ms). */
  timestamp: number;
}

/** Result of a provider fetch call. */
export interface FetchResult {
  items: WatcherItem[];
  /** Opaque cursor for the next fetch. */
  watermark: string;
}

/**
 * A watcher provider adapts an external API into the watcher system.
 * Each provider knows how to poll for new events and track its position.
 */
export interface WatcherProvider {
  /** Unique provider key (e.g. 'gmail', 'stripe'). */
  id: string;
  /** Human-readable name. */
  displayName: string;
  /** Credential service required (e.g. 'integration:gmail'). */
  requiredCredentialService: string;

  /**
   * Fetch new events since the given watermark.
   * Returns new items and an updated watermark.
   */
  fetchNew(
    credentialService: string,
    watermark: string | null,
    config: Record<string, unknown>,
  ): Promise<FetchResult>;

  /**
   * Get the initial watermark (start from "now" so we don't replay history).
   */
  getInitialWatermark(credentialService: string): Promise<string>;
}
