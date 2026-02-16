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

    // Pass-through from WatchSession
    @Published public var elapsedSeconds: Double = 0
    @Published public var captureCount: Int = 0
    @Published public var currentApp: String = ""

    public let durationSeconds: Int
    public let intervalSeconds: Int

    private var watchSession: WatchSession?
    private var daemonClient: DaemonClient?
    private var messageSubscription: Task<Void, Never>?
    private var watchSessionObserver: Task<Void, Never>?
    private var expectedWatchId: String?

    public init(durationSeconds: Int, intervalSeconds: Int = 10) {
        self.durationSeconds = durationSeconds
        self.intervalSeconds = intervalSeconds
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
                case .rideShotgunResult(let result):
                    self.handleRideShotgunResult(result)
                default:
                    break
                }
            }
        }

        // Send ride_shotgun_start to daemon
        do {
            log.info("[SHOTGUN-DEBUG] Sending ride_shotgun_start to daemon")
            try daemonClient.send(RideShotgunStartMessage(
                durationSeconds: Double(durationSeconds),
                intervalSeconds: Double(intervalSeconds)
            ))
            log.info("[SHOTGUN-DEBUG] ride_shotgun_start sent successfully")
        } catch {
            log.error("[SHOTGUN-DEBUG] Failed to send ride_shotgun_start: \(error.localizedDescription)")
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

    // MARK: - Private

    private func handleWatchStarted(_ message: WatchStartedMessage, daemonClient: DaemonClient) {
        guard state == .starting else {
            log.warning("[SHOTGUN-DEBUG] Received watch_started but state is \(String(describing: self.state)), ignoring")
            return
        }

        log.info("[SHOTGUN-DEBUG] Received watch_started: watchId=\(message.watchId) sessionId=\(message.sessionId)")
        expectedWatchId = message.watchId

        let session = WatchSession(
            watchId: message.watchId,
            sessionId: message.sessionId,
            durationSeconds: durationSeconds,
            intervalSeconds: intervalSeconds
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
        log.info("[SHOTGUN-DEBUG] Received ride_shotgun_result: watchId=\(result.watchId) observationCount=\(result.observationCount) summaryLength=\(result.summary.count)")
        guard state == .capturing || state == .summarizing else {
            log.warning("[SHOTGUN-DEBUG] Ignoring ride_shotgun_result — state is \(String(describing: self.state)), expected capturing or summarizing")
            return
        }
        guard result.watchId == expectedWatchId else {
            log.warning("[SHOTGUN-DEBUG] Ignoring ride_shotgun_result — watchId mismatch: got \(result.watchId), expected \(self.expectedWatchId ?? "nil")")
            return
        }

        summary = result.summary
        observationCount = result.observationCount
        state = .complete

        log.info("[SHOTGUN-DEBUG] Ride shotgun session complete: \(result.observationCount) observations, summary=\(result.summary.prefix(150))")
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
