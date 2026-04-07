// Home feed: events for feed updates pushed to connected clients.

// === Server → Client ===

/** Sent by the daemon when the home feed JSON file has been updated. */
export interface HomeFeedUpdated {
  type: "home_feed_updated";
}

// --- Domain-level union aliases (consumed by the barrel file) ---

export type _HomeServerMessages = HomeFeedUpdated;
