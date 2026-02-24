import Foundation
import VellumAssistantShared
import os

private let log = Logger(subsystem: Bundle.main.bundleIdentifier ?? "com.vellum.vellum-assistant", category: "RideShotgunSession")

@MainActor
public final class RideShotgunSession: ObservableObject {
    public enum State: Equatable {
        case idle
        case starting
        case capturing
        case summarizing
        case complete
        case failed(String)
        case cancelled
    }

    @Published public var state: State = .idle
    @Published public var summary: String = ""
    @Published public var observationCount: Int = 0
    @Published public var recordingId: String?
    @Published public var recordingPath: String?
    @Published public var networkEntryCount: Int = 0
    @Published public var statusMessage: String = ""
    @Published public var idleHint: Bool = false

    // Pass-through from WatchSession
    @Published public var elapsedSeconds: Double = 0
    @Published public var captureCount: Int = 0
    @Published public var currentApp: String = ""

    public let durationSeconds: Int
    public let intervalSeconds: Int
    public let mode: String?
    public let targetDomain: String?
    public var isLearnMode: Bool { mode == "learn" }

    private var watchSession: WatchSession?
    private var daemonClient: DaemonClient?
    private var messageSubscription: Task<Void, Never>?
    private var watchSessionObserver: Task<Void, Never>?
    private var expectedWatchId: String?

    public init(durationSeconds: Int, intervalSeconds: Int = 10, mode: String? = nil, targetDomain: String? = nil) {
        self.durationSeconds = durationSeconds
        self.intervalSeconds = intervalSeconds
        self.mode = mode
        self.targetDomain = targetDomain
    }

    public func start(daemonClient: DaemonClient) {
        guard state == .idle else {
            log.warning("Cannot start ride shotgun session: already in state \(String(describing: self.state))")
            return
        }
        self.daemonClient = daemonClient
        state = .starting

        log.info("Starting ride shotgun session: duration=\(self.durationSeconds)s interval=\(self.intervalSeconds)s")

        // Subscribe to daemon messages for watch_started and ride_shotgun_result
        let stream = daemonClient.subscribe()
        messageSubscription = Task { [weak self] in
            for await message in stream {
                guard let self else { return }
                switch message {
                case .watchStarted(let started):
                    self.handleWatchStarted(started, daemonClient: daemonClient)
                case .rideShotgunProgress(let progress):
                    if let count = progress.networkEntryCount {
                        self.networkEntryCount = count
                    }
                    if let msg = progress.statusMessage, !msg.isEmpty {
                        self.statusMessage = msg
                    }
                    if let idle = progress.idleHint, idle {
                        self.idleHint = true
                    }
                case .rideShotgunResult(let result):
                    self.handleRideShotgunResult(result)
                default:
                    break
                }
            }
        }

        // Send ride_shotgun_start to daemon
        do {
            log.debug("Sending ride_shotgun_start to daemon: mode=\(self.mode ?? "observe") targetDomain=\(self.targetDomain ?? "nil")")
            try daemonClient.send(RideShotgunStartMessage(
                durationSeconds: Double(durationSeconds),
                intervalSeconds: Double(intervalSeconds),
                mode: mode,
                targetDomain: targetDomain
            ))
            log.debug("ride_shotgun_start sent successfully")
        } catch {
            log.error("Failed to send ride_shotgun_start: \(error.localizedDescription)")
            state = .failed("Failed to start session")
            cleanup()
        }
    }

    public func cancel() {
        log.info("Ride shotgun session cancelled")
        watchSession?.stop()
        state = .cancelled
        cleanup()
    }

    /// Stop the session early but let the daemon finalize (save recording, generate summary).
    /// The result will arrive via ride_shotgun_result as normal.
    public func stopEarly() {
        guard let watchId = expectedWatchId, let daemonClient else {
            log.warning("Cannot stop early: no watchId or daemon client")
            cancel()
            return
        }
        log.info("Requesting early stop for watchId=\(watchId)")
        do {
            try daemonClient.send(RideShotgunStopMessage(watchId: watchId))
            state = .summarizing
        } catch {
            log.error("Failed to send ride_shotgun_stop: \(error.localizedDescription)")
            cancel()
        }
    }

    // MARK: - Private

    private func handleWatchStarted(_ message: WatchStartedMessage, daemonClient: DaemonClient) {
        guard state == .starting else {
            log.warning("Received watch_started but state is \(String(describing: self.state)), ignoring")
            return
        }

        log.debug("Received watch_started: watchId=\(message.watchId) sessionId=\(message.sessionId)")
        expectedWatchId = message.watchId

        let session = WatchSession(
            watchId: message.watchId,
            sessionId: message.sessionId,
            durationSeconds: durationSeconds,
            intervalSeconds: intervalSeconds,
            isLearnMode: isLearnMode
        )
        self.watchSession = session
        session.start(daemonClient: daemonClient)
        state = .capturing

        log.info("Watch session started: watchId=\(message.watchId)")

        // Observe WatchSession published properties
        watchSessionObserver = Task { [weak self, weak session] in
            guard let session else { return }
            while !Task.isCancelled {
                try? await Task.sleep(nanoseconds: 500_000_000) // 0.5s poll
                guard let self, !Task.isCancelled else { return }
                self.elapsedSeconds = session.elapsedSeconds
                self.captureCount = session.captureCount
                self.currentApp = session.currentApp

                // When WatchSession completes, transition to summarizing
                if session.state == .complete && self.state == .capturing {
                    self.state = .summarizing
                    log.info("Capture complete, waiting for summary...")
                }
            }
        }
    }

    private func handleRideShotgunResult(_ result: RideShotgunResultMessage) {
        log.debug("Received ride_shotgun_result: watchId=\(result.watchId) observationCount=\(result.observationCount) summaryLength=\(result.summary.count)")
        guard state == .capturing || state == .summarizing else {
            log.warning("Ignoring ride_shotgun_result — state is \(String(describing: self.state)), expected capturing or summarizing")
            return
        }
        guard result.watchId == expectedWatchId else {
            log.warning("Ignoring ride_shotgun_result — watchId mismatch: got \(result.watchId), expected \(self.expectedWatchId ?? "nil")")
            return
        }

        summary = result.summary
        observationCount = result.observationCount
        recordingId = result.recordingId
        recordingPath = result.recordingPath
        state = .complete

        log.debug("Ride shotgun session complete: \(result.observationCount) observations, recordingId=\(result.recordingId ?? "nil")")
        cleanup()
    }

    private func cleanup() {
        watchSession?.stop()
        watchSession = nil
        messageSubscription?.cancel()
        messageSubscription = nil
        watchSessionObserver?.cancel()
        watchSessionObserver = nil
    }
}
