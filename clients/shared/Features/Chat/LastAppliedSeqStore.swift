import Foundation
import os

private let log = Logger(subsystem: Bundle.appBundleIdentifier, category: "LastAppliedSeqStore")

/// Persists the highest `seq` the client has successfully applied for each
/// conversation. The reducer (`MessageStreamReducer`) records every applied
/// event here; on SSE (re)connect, `EventStreamClient` reads the value back
/// and sends it as the `Last-Event-Id` (a `?lastEventId=N` query parameter,
/// since the daemon accepts both) so the durable event log only replays
/// events the client hasn't seen.
///
/// Backed by `UserDefaults` under the `vellum.streaming.lastAppliedSeq`
/// namespace. The value space is per-conversation — `setSeq` is a monotonic
/// max so out-of-order updates can't move the watermark backward.
///
/// Concurrency: the store is `Sendable`-safe via a NSLock; `UserDefaults`
/// itself is thread-safe but the read-then-write `max` operation needs
/// serialization to avoid losing increments under concurrent writers.
public final class LastAppliedSeqStore: @unchecked Sendable {

    public static let shared = LastAppliedSeqStore()

    private let defaults: UserDefaults
    private let lock = NSLock()
    private static let keyPrefix = "vellum.streaming.lastAppliedSeq."

    public init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
    }

    /// Returns the stored seq for `conversationId`, or `nil` if the client
    /// has never applied an event for this conversation.
    public func seq(forConversation conversationId: String) -> Int? {
        let key = Self.key(for: conversationId)
        lock.lock()
        defer { lock.unlock() }
        guard defaults.object(forKey: key) != nil else { return nil }
        return defaults.integer(forKey: key)
    }

    /// Monotonically advance the stored seq for `conversationId`. A `seq`
    /// less than or equal to the existing watermark is a no-op so replayed
    /// events can't move the watermark backward.
    public func setSeq(_ seq: Int, forConversation conversationId: String) {
        guard seq > 0 else { return }
        let key = Self.key(for: conversationId)
        lock.lock()
        defer { lock.unlock() }
        let existing = defaults.object(forKey: key) != nil ? defaults.integer(forKey: key) : 0
        if seq > existing {
            defaults.set(seq, forKey: key)
        }
    }

    /// Clear the stored seq for `conversationId`. Called when the user
    /// deletes a conversation so the next replay isn't gated on a stale
    /// watermark.
    public func clear(conversationId: String) {
        let key = Self.key(for: conversationId)
        lock.lock()
        defer { lock.unlock() }
        defaults.removeObject(forKey: key)
    }

    private static func key(for conversationId: String) -> String {
        keyPrefix + conversationId
    }
}
