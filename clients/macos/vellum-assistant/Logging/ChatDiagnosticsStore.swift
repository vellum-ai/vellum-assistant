import CoreGraphics
import Foundation
import os

private let log = Logger(
    subsystem: Bundle.appBundleIdentifier,
    category: "ChatDiagnostics"
)

// MARK: - Numeric Sanitization

/// Collects the names of fields whose values were non-finite (nan, inf, -inf)
/// so they can be reported downstream without crashing JSON encoding.
struct NumericSanitizer: Sendable {
    /// Names of fields that were dropped because their value was non-finite.
    private(set) var droppedFields: [String] = []

    /// Returns a finite `Double` if the input is finite, otherwise records the
    /// field name and returns `nil`.
    mutating func sanitize(_ value: CGFloat?, field: String) -> Double? {
        guard let v = value else { return nil }
        let d = Double(v)
        guard d.isFinite else {
            droppedFields.append(field)
            return nil
        }
        return d
    }

    /// Returns a finite `Double` if the input is finite, otherwise records the
    /// field name and returns `nil`.
    mutating func sanitize(_ value: Double?, field: String) -> Double? {
        guard let v = value else { return nil }
        guard v.isFinite else {
            droppedFields.append(field)
            return nil
        }
        return v
    }

    /// The list of dropped field names, or `nil` if no fields were dropped.
    var nonFiniteFields: [String]? {
        droppedFields.isEmpty ? nil : droppedFields
    }
}

// MARK: - Event Payloads

/// Kind of diagnostic event. The raw value is the string written into the
/// JSONL session log so it must remain stable across versions.
enum ChatDiagnosticEventKind: String, Codable, Sendable {
    case scrollPositionChanged
    case scrollLoopDetected
    case progressCardTransition
    case transcriptSnapshotCaptured
    case stallDetected
    case appLifecycle
}

/// Content-safe popup state for the composer.
/// The raw value is written into JSONL logs and must remain stable.
enum ComposerPopupState: String, Codable, Sendable {
    case slash
    case emoji
    case inactive = "none"
}

/// Content-safe scroll intent source.
/// The raw value is written into JSONL logs and must remain stable.
enum ScrollIntentSource: String, Codable, Sendable {
    case followBottom
    case manual
    case anchor
    case search
    case resizeRecovery
}

/// Content-safe diagnostic event.
///
/// **Privacy invariant**: events record only identifiers, flags, counts, and
/// geometry. They never include message text, tool input/output bodies,
/// inline surface HTML, or attachment contents.
struct ChatDiagnosticEvent: Codable, Sendable {
    /// Auto-generated unique identifier for this event.
    let id: String
    /// When the event was recorded.
    let timestamp: Date
    /// The diagnostic event category.
    let kind: ChatDiagnosticEventKind
    /// Conversation the event relates to, if any.
    let conversationId: String?
    /// Human-readable reason or trigger description (no user content).
    let reason: String?

    // MARK: Counts & flags

    /// Number of messages in the transcript at event time.
    let messageCount: Int?
    /// Number of visible tool calls at event time.
    let toolCallCount: Int?
    /// Whether the transcript was pinned to the bottom.
    let isPinnedToBottom: Bool?
    /// Whether the user was actively scrolling.
    let isUserScrolling: Bool?

    // MARK: Geometry

    /// Scroll offset Y at event time.
    let scrollOffsetY: Double?
    /// Visible content height at event time.
    let contentHeight: Double?
    /// Viewport height at event time.
    let viewportHeight: Double?

    // MARK: Surface metadata

    /// The chat-surface component that originated this event.
    let source: ChatSurfaceMetrics.Source?
    /// The user/system interaction that triggered this event.
    let interaction: ChatSurfaceMetrics.Interaction?
    /// Number of progress cards currently in the expanded state.
    let expandedProgressCardCount: Int?
    /// Current composer popup state (slash picker, emoji picker, or none).
    let composerPopupState: ComposerPopupState?
    /// The source of the current scroll intent.
    let scrollIntentSource: ScrollIntentSource?

    // MARK: Sanitization metadata

    /// Names of geometry fields whose original values were non-finite
    /// (nan, inf, -inf) and were replaced with `nil` during construction.
    let nonFiniteFields: [String]?

    init(
        kind: ChatDiagnosticEventKind,
        conversationId: String? = nil,
        reason: String? = nil,
        messageCount: Int? = nil,
        toolCallCount: Int? = nil,
        isPinnedToBottom: Bool? = nil,
        isUserScrolling: Bool? = nil,
        scrollOffsetY: Double? = nil,
        contentHeight: Double? = nil,
        viewportHeight: Double? = nil,
        source: ChatSurfaceMetrics.Source? = nil,
        interaction: ChatSurfaceMetrics.Interaction? = nil,
        expandedProgressCardCount: Int? = nil,
        composerPopupState: ComposerPopupState? = nil,
        scrollIntentSource: ScrollIntentSource? = nil,
        nonFiniteFields: [String]? = nil
    ) {
        self.id = UUID().uuidString
        self.timestamp = Date()
        self.kind = kind
        self.conversationId = conversationId
        self.reason = reason
        self.messageCount = messageCount
        self.toolCallCount = toolCallCount
        self.isPinnedToBottom = isPinnedToBottom
        self.isUserScrolling = isUserScrolling
        self.scrollOffsetY = scrollOffsetY
        self.contentHeight = contentHeight
        self.viewportHeight = viewportHeight
        self.source = source
        self.interaction = interaction
        self.expandedProgressCardCount = expandedProgressCardCount
        self.composerPopupState = composerPopupState
        self.scrollIntentSource = scrollIntentSource
        self.nonFiniteFields = nonFiniteFields
    }

    /// Test-only initializer that allows setting id and timestamp explicitly.
    init(
        id: String,
        timestamp: Date,
        kind: ChatDiagnosticEventKind,
        conversationId: String? = nil,
        reason: String? = nil,
        messageCount: Int? = nil,
        toolCallCount: Int? = nil,
        isPinnedToBottom: Bool? = nil,
        isUserScrolling: Bool? = nil,
        scrollOffsetY: Double? = nil,
        contentHeight: Double? = nil,
        viewportHeight: Double? = nil,
        source: ChatSurfaceMetrics.Source? = nil,
        interaction: ChatSurfaceMetrics.Interaction? = nil,
        expandedProgressCardCount: Int? = nil,
        composerPopupState: ComposerPopupState? = nil,
        scrollIntentSource: ScrollIntentSource? = nil,
        nonFiniteFields: [String]? = nil
    ) {
        self.id = id
        self.timestamp = timestamp
        self.kind = kind
        self.conversationId = conversationId
        self.reason = reason
        self.messageCount = messageCount
        self.toolCallCount = toolCallCount
        self.isPinnedToBottom = isPinnedToBottom
        self.isUserScrolling = isUserScrolling
        self.scrollOffsetY = scrollOffsetY
        self.contentHeight = contentHeight
        self.viewportHeight = viewportHeight
        self.source = source
        self.interaction = interaction
        self.expandedProgressCardCount = expandedProgressCardCount
        self.composerPopupState = composerPopupState
        self.scrollIntentSource = scrollIntentSource
        self.nonFiniteFields = nonFiniteFields
    }
}

// MARK: - Transcript Snapshot

/// A point-in-time snapshot of per-conversation transcript state.
/// Used by the debug panel and exported with hang diagnostics.
///
/// **Privacy invariant**: contains only identifiers, flags, counts, timestamps,
/// and numeric geometry. Never includes message text, tool input/output bodies,
/// inline surface HTML, or attachment contents.
struct ChatTranscriptSnapshot: Codable, Sendable {
    let conversationId: String
    let capturedAt: Date
    let messageCount: Int
    let toolCallCount: Int
    let isPinnedToBottom: Bool
    let isUserScrolling: Bool
    let scrollOffsetY: Double?
    let contentHeight: Double?
    let viewportHeight: Double?

    // MARK: Extended diagnostics (populated by scroll instrumentation)

    /// Whether the transcript scroll position is near the bottom.
    let isNearBottom: Bool?
    /// Whether the scroll system has received initial interaction (not in initialLoad mode).
    let hasBeenInteracted: Bool?
    /// Whether a pagination load is currently in flight.
    let isPaginationInFlight: Bool?
    /// The current scroll mode (e.g. "followingBottom", "freeBrowsing", "programmaticScroll").
    let scrollMode: String?
    /// The message ID the scroll view is anchored to, if any.
    let anchorMessageId: String?
    /// The message ID currently highlighted (e.g. from search), if any.
    let highlightedMessageId: String?
    /// The minY geometry value of the anchor message row, if measured.
    let anchorMinY: Double?
    /// The Y position of the tail anchor (bottom of visible content).
    let tailAnchorY: Double?
    /// The height of the scroll viewport.
    let scrollViewportHeight: Double?
    /// The width of the chat container.
    let containerWidth: Double?
    /// Human-readable reason for the last `scrollTo` call.
    let lastScrollToReason: String?
    /// Legacy field, always `nil`. Retained for backward compatibility with
    /// serialized snapshots.
    let lastLoopWarningTimestamp: Date?
    /// Legacy field, always `nil`. Retained for backward compatibility with
    /// serialized snapshots.
    let scrollLoopGuardCounts: [String: Int]?

    // MARK: Surface metadata

    /// The chat-surface component that last updated this snapshot.
    let source: ChatSurfaceMetrics.Source?
    /// Number of progress cards currently in the expanded state.
    let expandedProgressCardCount: Int?
    /// Current composer popup state (slash picker, emoji picker, or none).
    let composerPopupState: ComposerPopupState?
    /// The source of the current scroll intent.
    let scrollIntentSource: ScrollIntentSource?

    // MARK: Sanitization metadata

    /// Names of geometry fields whose original values were non-finite
    /// (nan, inf, -inf) and were replaced with `nil` during construction.
    let nonFiniteFields: [String]?

    init(
        conversationId: String,
        capturedAt: Date,
        messageCount: Int,
        toolCallCount: Int,
        isPinnedToBottom: Bool,
        isUserScrolling: Bool,
        scrollOffsetY: Double? = nil,
        contentHeight: Double? = nil,
        viewportHeight: Double? = nil,
        isNearBottom: Bool? = nil,
        hasBeenInteracted: Bool? = nil,
        isPaginationInFlight: Bool? = nil,
        scrollMode: String? = nil,
        anchorMessageId: String? = nil,
        highlightedMessageId: String? = nil,
        anchorMinY: Double? = nil,
        tailAnchorY: Double? = nil,
        scrollViewportHeight: Double? = nil,
        containerWidth: Double? = nil,
        lastScrollToReason: String? = nil,
        lastLoopWarningTimestamp: Date? = nil,
        scrollLoopGuardCounts: [String: Int]? = nil,
        source: ChatSurfaceMetrics.Source? = nil,
        expandedProgressCardCount: Int? = nil,
        composerPopupState: ComposerPopupState? = nil,
        scrollIntentSource: ScrollIntentSource? = nil,
        nonFiniteFields: [String]? = nil
    ) {
        self.conversationId = conversationId
        self.capturedAt = capturedAt
        self.messageCount = messageCount
        self.toolCallCount = toolCallCount
        self.isPinnedToBottom = isPinnedToBottom
        self.isUserScrolling = isUserScrolling
        self.scrollOffsetY = scrollOffsetY
        self.contentHeight = contentHeight
        self.viewportHeight = viewportHeight
        self.isNearBottom = isNearBottom
        self.hasBeenInteracted = hasBeenInteracted
        self.isPaginationInFlight = isPaginationInFlight
        self.scrollMode = scrollMode
        self.anchorMessageId = anchorMessageId
        self.highlightedMessageId = highlightedMessageId
        self.anchorMinY = anchorMinY
        self.tailAnchorY = tailAnchorY
        self.scrollViewportHeight = scrollViewportHeight
        self.containerWidth = containerWidth
        self.lastScrollToReason = lastScrollToReason
        self.lastLoopWarningTimestamp = lastLoopWarningTimestamp
        self.scrollLoopGuardCounts = scrollLoopGuardCounts
        self.source = source
        self.expandedProgressCardCount = expandedProgressCardCount
        self.composerPopupState = composerPopupState
        self.scrollIntentSource = scrollIntentSource
        self.nonFiniteFields = nonFiniteFields
    }
}

/// Background-readable cache for the latest sanitized diagnostics snapshot.
///
/// Kept outside `ChatDiagnosticsStore` so background readers do not need to
/// access the store's `@MainActor` singleton just to read the fallback copy.
final class LastKnownDiagnosticsCache: @unchecked Sendable {
    static let shared = LastKnownDiagnosticsCache()

    private let snapshotLock = OSAllocatedUnfairLock<LastKnownDiagnosticsSnapshot?>(initialState: nil)

    private init() {}

    func update(_ snapshot: LastKnownDiagnosticsSnapshot?) {
        snapshotLock.withLock { $0 = snapshot }
    }

    func snapshot() -> LastKnownDiagnosticsSnapshot? {
        snapshotLock.withLock { $0 }
    }
}

// MARK: - ChatDiagnosticsStore

/// Shared diagnostics store for the chat transcript.
///
/// Owns three pieces of content-safe state:
/// 1. A bounded in-memory ring buffer of recent `ChatDiagnosticEvent` values.
/// 2. A per-conversation `ChatTranscriptSnapshot`.
/// 3. A per-launch JSONL session log file under
///    `~/Library/Application Support/vellum-assistant/logs/`.
@MainActor
final class ChatDiagnosticsStore {

    static let shared = ChatDiagnosticsStore()

    // MARK: - Configuration

    /// Maximum number of events retained in the in-memory ring buffer.
    static let ringBufferCapacity = 500

    /// Maximum session log file size in bytes (1 MB).
    static let maxSessionLogBytes = 1_048_576

    /// Maximum number of session log files to retain on disk.
    static let maxSessionLogFiles = 10

    /// Maximum number of per-conversation transcript snapshots retained.
    /// When exceeded, the least-recently-updated conversation is evicted.
    static let maxTranscriptSnapshots = 10

    // MARK: - State

    /// Bounded ring buffer of recent events (oldest evicted first).
    private(set) var events: [ChatDiagnosticEvent] = []

    /// Per-conversation transcript snapshots, keyed by conversation ID.
    private(set) var transcriptSnapshots: [String: ChatTranscriptSnapshot] = [:]

    /// Insertion/access order for transcript snapshot keys (most recent last).
    /// Used for LRU eviction when `transcriptSnapshots` exceeds `maxTranscriptSnapshots`.
    private var snapshotOrder: [String] = []

    // MARK: - Session Log

    private let logsDirectory: URL
    private let sessionLogURL: URL
    private let encoder: JSONEncoder
    private var sessionLogBytesWritten: Int = 0
    private var sessionLogHandle: FileHandle?

    // MARK: - Init

    init() {
        let appSupport = FileManager.default.urls(
            for: .applicationSupportDirectory,
            in: .userDomainMask
        ).first ?? FileManager.default.temporaryDirectory

        let logsDir = appSupport
            .appendingPathComponent("vellum-assistant", isDirectory: true)
            .appendingPathComponent("logs", isDirectory: true)
        self.logsDirectory = logsDir

        // Create logs directory if needed.
        try? FileManager.default.createDirectory(
            at: logsDir,
            withIntermediateDirectories: true
        )

        // Name the session log with launch timestamp and PID.
        let timestamp = Date().iso8601String
            .replacingOccurrences(of: ":", with: "-")
        let pid = ProcessInfo.processInfo.processIdentifier
        let filename = "chat-diagnostics-\(timestamp)-\(pid).jsonl"
        self.sessionLogURL = logsDir.appendingPathComponent(filename)

        self.encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .iso8601
        encoder.outputFormatting = [.sortedKeys]

        // Create the session log file and open a handle for appending.
        FileManager.default.createFile(atPath: sessionLogURL.path, contents: nil)
        self.sessionLogHandle = FileHandle(forWritingAtPath: sessionLogURL.path)

        // Prune old session logs.
        pruneSessionLogs()

        log.info("Chat diagnostics session log: \(self.sessionLogURL.lastPathComponent)")
    }

    deinit {
        try? sessionLogHandle?.close()
    }

    // MARK: - Recording Events

    /// Records a diagnostic event into the ring buffer and session log.
    func record(_ event: ChatDiagnosticEvent) {
        // Append to ring buffer, evicting oldest if at capacity.
        events.append(event)
        if events.count > Self.ringBufferCapacity {
            events.removeFirst(events.count - Self.ringBufferCapacity)
        }

        // Write to session log if under size cap.
        writeToSessionLog(event)

        // Refresh the background-safe snapshot.
        refreshLastKnownSnapshot()
    }

    // MARK: - Transcript Snapshots

    /// Updates the transcript snapshot for a conversation.
    ///
    /// Maintains an LRU eviction policy: when the number of snapshots exceeds
    /// `maxTranscriptSnapshots`, the least-recently-updated conversation is removed.
    func updateSnapshot(_ snapshot: ChatTranscriptSnapshot) {
        let key = snapshot.conversationId

        // Move this key to the end of the order (most recently used).
        if let index = snapshotOrder.firstIndex(of: key) {
            snapshotOrder.remove(at: index)
        }
        snapshotOrder.append(key)

        transcriptSnapshots[key] = snapshot

        // Evict oldest entries if over capacity.
        while snapshotOrder.count > Self.maxTranscriptSnapshots {
            let evicted = snapshotOrder.removeFirst()
            transcriptSnapshots.removeValue(forKey: evicted)
        }

        // Refresh the background-safe snapshot.
        refreshLastKnownSnapshot()
    }

    /// Returns the current snapshot for a conversation, if any.
    func snapshot(for conversationId: String) -> ChatTranscriptSnapshot? {
        transcriptSnapshots[conversationId]
    }

    /// Removes the snapshot for a conversation.
    func removeSnapshot(for conversationId: String) {
        transcriptSnapshots.removeValue(forKey: conversationId)
        if let index = snapshotOrder.firstIndex(of: conversationId) {
            snapshotOrder.remove(at: index)
        }

        // Refresh the background-safe snapshot.
        refreshLastKnownSnapshot()
    }

    // MARK: - Session Log Writing

    private func writeToSessionLog(_ event: ChatDiagnosticEvent) {
        guard sessionLogBytesWritten < Self.maxSessionLogBytes else { return }

        do {
            var data = try encoder.encode(event)
            data.append(contentsOf: [0x0A]) // newline
            let size = data.count

            guard sessionLogBytesWritten + size <= Self.maxSessionLogBytes else {
                return
            }

            sessionLogHandle?.write(data)
            sessionLogBytesWritten += size
        } catch {
            log.error("Failed to encode diagnostic event: \(error)")
        }
    }

    // MARK: - Session Log Pruning

    /// Removes older session log files so only the newest
    /// `maxSessionLogFiles` remain.
    func pruneSessionLogs() {
        let fm = FileManager.default
        guard let contents = try? fm.contentsOfDirectory(
            at: logsDirectory,
            includingPropertiesForKeys: [.contentModificationDateKey],
            options: [.skipsHiddenFiles]
        ) else { return }

        // Filter to chat diagnostics JSONL files.
        let diagnosticFiles = contents.filter {
            $0.lastPathComponent.hasPrefix("chat-diagnostics-")
                && $0.pathExtension == "jsonl"
        }

        guard diagnosticFiles.count > Self.maxSessionLogFiles else { return }

        // Sort newest first by modification date.
        let sorted = diagnosticFiles.sorted { a, b in
            let aDate = (try? a.resourceValues(forKeys: [.contentModificationDateKey]))?.contentModificationDate ?? .distantPast
            let bDate = (try? b.resourceValues(forKeys: [.contentModificationDateKey]))?.contentModificationDate ?? .distantPast
            return aDate > bDate
        }

        // Remove all beyond the retention limit.
        for file in sorted.dropFirst(Self.maxSessionLogFiles) {
            do {
                try fm.removeItem(at: file)
                log.info("Pruned old session log: \(file.lastPathComponent)")
            } catch {
                log.warning("Failed to prune session log \(file.lastPathComponent): \(error)")
            }
        }
    }

    // MARK: - Query Helpers

    /// Returns events for a specific conversation.
    func events(for conversationId: String) -> [ChatDiagnosticEvent] {
        events.filter { $0.conversationId == conversationId }
    }

    /// Returns the most recent N events.
    func recentEvents(_ count: Int) -> [ChatDiagnosticEvent] {
        Array(events.suffix(count))
    }

    // MARK: - Background-Safe Last-Known Snapshot

    /// Maximum number of events retained in the last-known snapshot.
    static let lastKnownEventCapacity = 50

    /// A background-safe snapshot of the most recent sanitized diagnostics.
    ///
    /// Updated on every `record(_:)` and `updateSnapshot(_:)` call so that
    /// the stall detector's background queue can read it without awaiting
    /// the main actor. This is the fallback data source when the main thread
    /// is wedged and `enrichWithDiagnosticsAsync()` never completes.
    ///
    /// **Thread safety**: Written only from `@MainActor`; mirrored into
    /// `LastKnownDiagnosticsCache` for lock-protected background reads.
    private(set) var lastKnownDiagnostics: LastKnownDiagnosticsSnapshot? {
        didSet {
            LastKnownDiagnosticsCache.shared.update(lastKnownDiagnostics)
        }
    }

    /// Returns the last-known diagnostics snapshot from any thread.
    /// This is safe to call from the stall detector's background queue.
    nonisolated func lastKnownDiagnosticsFromBackground() -> LastKnownDiagnosticsSnapshot? {
        LastKnownDiagnosticsCache.shared.snapshot()
    }

    /// Rebuilds the last-known diagnostics snapshot from current state.
    private func refreshLastKnownSnapshot() {
        let recentEvents = Array(events.suffix(Self.lastKnownEventCapacity))
        let snapshots = transcriptSnapshots.values.sorted { $0.conversationId < $1.conversationId }
        lastKnownDiagnostics = LastKnownDiagnosticsSnapshot(
            capturedAt: Date(),
            recentEvents: recentEvents,
            transcriptSnapshots: snapshots
        )
    }
}

// MARK: - Last-Known Diagnostics Snapshot

/// A point-in-time snapshot of the most recent sanitized diagnostic events
/// and transcript snapshots. Designed to be read from a background queue
/// without awaiting the main actor.
///
/// **Privacy invariant**: Contains only the same content-safe data as
/// `ChatDiagnosticEvent` and `ChatTranscriptSnapshot` — no user content.
struct LastKnownDiagnosticsSnapshot: Codable, Sendable {
    /// When this snapshot was captured.
    let capturedAt: Date
    /// Recent diagnostic events (up to `ChatDiagnosticsStore.lastKnownEventCapacity`).
    let recentEvents: [ChatDiagnosticEvent]
    /// Per-conversation transcript snapshots, sorted by conversation ID.
    let transcriptSnapshots: [ChatTranscriptSnapshot]
}
