import Foundation
import os

private let log = Logger(
    subsystem: Bundle.main.bundleIdentifier ?? "com.vellum.vellum-assistant",
    category: "HangContextWriter"
)

/// Writes `hang-context.json` to Application Support when the main thread
/// is wedged, capturing enough diagnostic context for post-mortem analysis.
///
/// The `writeHangContextSync` method performs file I/O on the calling thread,
/// which is expected to be the stall detector's background queue. This avoids
/// double-dispatching and ensures the file exists by the time the caller
/// continues. A separate `enrichWithDiagnostics` path attempts a best-effort
/// main-actor read; if the main thread is wedged it simply won't complete.
final class HangContextWriter: @unchecked Sendable {

    /// Protocol for providing diagnostic events from a background queue.
    /// The concrete implementation reads from `ChatDiagnosticsStore` on the main actor.
    /// Tests inject a synchronous stub.
    protocol DiagnosticsProvider: Sendable {
        func recentEvents() async -> [ChatDiagnosticEvent]
        func transcriptSnapshots() async -> [String: ChatTranscriptSnapshot]
    }

    /// Protocol for providing last-known diagnostics without awaiting the main actor.
    /// The concrete implementation reads the lock-guarded background copy from
    /// `ChatDiagnosticsStore`. Tests inject a stub.
    protocol LastKnownDiagnosticsProvider: Sendable {
        func lastKnownDiagnostics() -> LastKnownDiagnosticsSnapshot?
    }

    // MARK: - Configuration

    /// Directory where hang-context.json is written.
    let outputDirectory: URL

    /// Provider for diagnostic events and snapshots.
    let diagnosticsProvider: DiagnosticsProvider?

    /// Provider for last-known diagnostics readable from any thread.
    let lastKnownProvider: LastKnownDiagnosticsProvider?

    // MARK: - Private

    private let lock = NSLock()
    private var writeGeneration: Int = 0
    private var latestStallStartTime: Date?
    private var latestStallDurationSeconds: Double = 0

    private let encoder: JSONEncoder

    // MARK: - Init

    init(
        outputDirectory: URL? = nil,
        diagnosticsProvider: DiagnosticsProvider? = nil,
        lastKnownProvider: LastKnownDiagnosticsProvider? = nil
    ) {
        if let dir = outputDirectory {
            self.outputDirectory = dir
        } else {
            let appSupport = FileManager.default.urls(
                for: .applicationSupportDirectory,
                in: .userDomainMask
            ).first ?? FileManager.default.temporaryDirectory
            self.outputDirectory = appSupport
                .appendingPathComponent("vellum-assistant", isDirectory: true)
        }
        self.diagnosticsProvider = diagnosticsProvider
        self.lastKnownProvider = lastKnownProvider

        self.encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .iso8601
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
    }

    // MARK: - Synchronous Write

    /// Writes `hang-context.json` synchronously on the calling thread.
    ///
    /// This is safe to call from any background queue. The caller (typically
    /// `MainThreadStallDetector`) is responsible for ensuring this is not
    /// called from the main thread.
    func writeHangContextSync(
        stallStartTime: Date,
        stallDurationSeconds: Double,
        recentEvents: [ChatDiagnosticEvent] = [],
        transcriptSnapshots: [ChatTranscriptSnapshot] = [],
        samplingSkipped: Bool = false
    ) {
        lock.lock()
        writeGeneration += 1
        latestStallStartTime = stallStartTime
        latestStallDurationSeconds = stallDurationSeconds
        lock.unlock()

        let version = Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String
        let pid = ProcessInfo.processInfo.processIdentifier

        // If no explicit events/snapshots were provided, fall back to the
        // last-known background-safe snapshot so stage-one capture is useful
        // even when the main actor never satisfies enrichWithDiagnosticsAsync().
        var effectiveEvents = recentEvents
        var effectiveSnapshots = transcriptSnapshots
        var lastKnownCapturedAt: Date? = nil
        if effectiveEvents.isEmpty && effectiveSnapshots.isEmpty,
           let lastKnown = lastKnownProvider?.lastKnownDiagnostics() {
            effectiveEvents = lastKnown.recentEvents
            effectiveSnapshots = lastKnown.transcriptSnapshots
            lastKnownCapturedAt = lastKnown.capturedAt
        }

        let context = HangContext(
            stallStartTime: stallStartTime,
            stallDurationSeconds: stallDurationSeconds,
            pid: Int(pid),
            appVersion: version ?? "unknown",
            recentDiagnosticEvents: effectiveEvents,
            transcriptSnapshots: effectiveSnapshots,
            lastKnownDiagnosticsCapturedAt: lastKnownCapturedAt,
            samplingSkipped: samplingSkipped ? true : nil
        )

        do {
            try FileManager.default.createDirectory(
                at: outputDirectory,
                withIntermediateDirectories: true
            )
            let fileURL = outputDirectory.appendingPathComponent("hang-context.json")
            let data = try encoder.encode(context)
            try data.write(to: fileURL, options: .atomic)
            log.info("Wrote hang context: stall=\(String(format: "%.1f", stallDurationSeconds))s")
        } catch {
            log.error("Failed to write hang-context.json: \(error)")
        }
    }

    // MARK: - Async Enrichment

    /// Best-effort enrichment: reads diagnostics from the main actor and
    /// rewrites `hang-context.json` with the additional data. If the main
    /// thread is wedged, this call will not complete — which is fine because
    /// the synchronous initial write already captured the stall metadata.
    func enrichWithDiagnosticsAsync(
        stallStartTime: Date,
        stallDurationSeconds: Double
    ) {
        guard let provider = diagnosticsProvider else { return }
        lock.lock()
        let capturedGeneration = writeGeneration
        lock.unlock()

        Task.detached(priority: .utility) { [self] in
            let events = await provider.recentEvents()
            let snapshots = await provider.transcriptSnapshots()
            let sortedSnapshots = snapshots.values.sorted { $0.conversationId < $1.conversationId }

            // If a newer write occurred (e.g. Stage 2) while we were awaiting
            // diagnostics, use its duration so we don't overwrite with a stale value.
            self.lock.lock()
            let useLatest = self.writeGeneration > capturedGeneration
            let actualStartTime = useLatest ? (self.latestStallStartTime ?? stallStartTime) : stallStartTime
            let actualDuration = useLatest ? self.latestStallDurationSeconds : stallDurationSeconds
            self.lock.unlock()

            self.writeHangContextSync(
                stallStartTime: actualStartTime,
                stallDurationSeconds: actualDuration,
                recentEvents: events,
                transcriptSnapshots: sortedSnapshots
            )
        }
    }
}

// MARK: - Hang Context Model

/// Content-safe hang context written to disk during main-thread stalls.
struct HangContext: Codable, Sendable {
    let stallStartTime: Date
    let stallDurationSeconds: Double
    let pid: Int
    let appVersion: String
    let recentDiagnosticEvents: [ChatDiagnosticEvent]
    let transcriptSnapshots: [ChatTranscriptSnapshot]
    /// When the last-known diagnostics snapshot was captured, if the events and
    /// snapshots were sourced from the background-safe fallback rather than
    /// a live main-actor read. `nil` when diagnostics came from async enrichment.
    let lastKnownDiagnosticsCapturedAt: Date?
    /// Whether process sampling was skipped because `sendDiagnostics` is disabled.
    /// Present (and `true`) only when sampling was explicitly skipped.
    let samplingSkipped: Bool?

    init(
        stallStartTime: Date,
        stallDurationSeconds: Double,
        pid: Int,
        appVersion: String,
        recentDiagnosticEvents: [ChatDiagnosticEvent],
        transcriptSnapshots: [ChatTranscriptSnapshot],
        lastKnownDiagnosticsCapturedAt: Date? = nil,
        samplingSkipped: Bool? = nil
    ) {
        self.stallStartTime = stallStartTime
        self.stallDurationSeconds = stallDurationSeconds
        self.pid = pid
        self.appVersion = appVersion
        self.recentDiagnosticEvents = recentDiagnosticEvents
        self.transcriptSnapshots = transcriptSnapshots
        self.lastKnownDiagnosticsCapturedAt = lastKnownDiagnosticsCapturedAt
        self.samplingSkipped = samplingSkipped
    }
}

// MARK: - Default Diagnostics Provider

/// Production diagnostics provider that reads from `ChatDiagnosticsStore`
/// on the main actor.
struct MainActorDiagnosticsProvider: HangContextWriter.DiagnosticsProvider {
    func recentEvents() async -> [ChatDiagnosticEvent] {
        await MainActor.run {
            ChatDiagnosticsStore.shared.recentEvents(50)
        }
    }

    func transcriptSnapshots() async -> [String: ChatTranscriptSnapshot] {
        await MainActor.run {
            ChatDiagnosticsStore.shared.transcriptSnapshots
        }
    }
}

/// Production last-known diagnostics provider that reads the lock-guarded
/// background copy from `ChatDiagnosticsStore`. Safe to call from any thread.
struct BackgroundDiagnosticsProvider: HangContextWriter.LastKnownDiagnosticsProvider {
    func lastKnownDiagnostics() -> LastKnownDiagnosticsSnapshot? {
        ChatDiagnosticsStore.shared.lastKnownDiagnosticsFromBackground()
    }
}
