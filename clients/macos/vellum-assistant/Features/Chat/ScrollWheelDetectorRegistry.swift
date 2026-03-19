import Foundation

// MARK: - ScrollWheelDetectorRegistry

/// A single source of truth for how many scroll-wheel detectors are currently
/// active per conversation and window.
///
/// The existing `ScrollWheelDetector` (an `NSViewRepresentable` in ChatView)
/// installs a local `NSEvent` monitor on each appearance. SwiftUI's view
/// lifecycle can create duplicate instances when identity changes — for example
/// during conversation switches, sidebar toggles, or window restorations.
/// When multiple detectors exist for the same conversation/window pair, their
/// competing `onScrollUp` / `onScrollToBottom` callbacks cause scroll-position
/// fights that can freeze the UI.
///
/// This registry tracks every live detector by a caller-supplied ID so that:
/// 1. Duplicate-detector conditions are detectable without touching view code.
/// 2. Later instrumentation (PR 4) can call `register` / `unregister` from
///    the detector lifecycle and log warnings when duplicates appear.
/// 3. Stale entries (detectors that were never unregistered) can be identified
///    by comparing their install timestamps against a staleness threshold.
@MainActor
final class ScrollWheelDetectorRegistry {

    // MARK: - Entry

    /// Metadata for a single registered detector.
    struct Entry: Equatable, Sendable {
        /// Caller-supplied identifier for this detector instance.
        let detectorId: String

        /// The conversation this detector is attached to.
        let conversationId: String

        /// An opaque identifier for the window hosting this detector
        /// (e.g. `NSWindow.windowNumber` or a stable window UUID).
        let windowId: String

        /// Monotonic timestamp when the detector was registered
        /// (e.g. `ProcessInfo.processInfo.systemUptime`).
        let installedAt: TimeInterval

        /// Monotonic timestamp of the most recent update to this entry.
        var lastUpdatedAt: TimeInterval
    }

    // MARK: - Duplicate Report

    /// Describes a duplicate-detector condition for a conversation/window pair.
    struct DuplicateReport: Equatable, Sendable {
        let conversationId: String
        let windowId: String
        let detectorIds: [String]
        let count: Int
    }

    // MARK: - Internal State

    private var entries: [String: Entry] = [:]

    // MARK: - Public API

    /// The number of currently registered detectors.
    var activeCount: Int { entries.count }

    /// Registers a new detector. If an entry with the same `detectorId`
    /// already exists, it is replaced.
    func register(
        detectorId: String,
        conversationId: String,
        windowId: String,
        timestamp: TimeInterval
    ) {
        entries[detectorId] = Entry(
            detectorId: detectorId,
            conversationId: conversationId,
            windowId: windowId,
            installedAt: timestamp,
            lastUpdatedAt: timestamp
        )
    }

    /// Updates the `lastUpdatedAt` timestamp for an existing entry.
    /// No-op if the detector is not registered.
    func update(detectorId: String, timestamp: TimeInterval) {
        entries[detectorId]?.lastUpdatedAt = timestamp
    }

    /// Removes a detector from the registry.
    func unregister(detectorId: String) {
        entries.removeValue(forKey: detectorId)
    }

    /// Returns a snapshot of all currently registered entries.
    func snapshot() -> [Entry] {
        Array(entries.values)
    }

    /// Returns entries matching a specific conversation and window pair.
    func entries(conversationId: String, windowId: String) -> [Entry] {
        entries.values.filter {
            $0.conversationId == conversationId && $0.windowId == windowId
        }
    }

    // MARK: - Duplicate Detection

    /// Reports duplicate-detector conditions: conversation/window pairs that
    /// have more than one active detector.
    ///
    /// The per-detector throttle in `ScrollWheelDetector.Coordinator` assumes
    /// at most one detector per conversation/window. When duplicates exist,
    /// competing event monitors fight over scroll position and can cause
    /// freezes. This method surfaces those conditions for logging/diagnostics.
    func duplicates() -> [DuplicateReport] {
        // Group entries by (conversationId, windowId).
        var groups: [String: [Entry]] = [:]
        for entry in entries.values {
            let key = "\(entry.conversationId)|\(entry.windowId)"
            groups[key, default: []].append(entry)
        }

        return groups.compactMap { _, groupEntries in
            guard groupEntries.count > 1 else { return nil }
            let first = groupEntries[0]
            return DuplicateReport(
                conversationId: first.conversationId,
                windowId: first.windowId,
                detectorIds: groupEntries.map(\.detectorId).sorted(),
                count: groupEntries.count
            )
        }.sorted { $0.conversationId < $1.conversationId }
    }

    /// Returns true if more than one detector is registered for the given
    /// conversation and window pair.
    func hasDuplicates(conversationId: String, windowId: String) -> Bool {
        entries(conversationId: conversationId, windowId: windowId).count > 1
    }

    // MARK: - Stale Detection

    /// Returns entries whose `lastUpdatedAt` is older than the given threshold,
    /// indicating detectors that may have leaked (never unregistered).
    ///
    /// - Parameters:
    ///   - threshold: Maximum age in seconds. Entries older than
    ///     `now - threshold` are considered stale.
    ///   - now: The current monotonic timestamp.
    func staleEntries(threshold: TimeInterval, now: TimeInterval) -> [Entry] {
        let cutoff = now - threshold
        return entries.values.filter { $0.lastUpdatedAt < cutoff }
    }

    /// Removes all entries whose `lastUpdatedAt` is older than the given
    /// threshold. Returns the removed entries for logging.
    @discardableResult
    func purgeStale(threshold: TimeInterval, now: TimeInterval) -> [Entry] {
        let stale = staleEntries(threshold: threshold, now: now)
        for entry in stale {
            entries.removeValue(forKey: entry.detectorId)
        }
        return stale
    }

    /// Removes all entries. Useful on conversation switch or teardown.
    func removeAll() {
        entries.removeAll()
    }
}
