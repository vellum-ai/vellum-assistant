#if canImport(UIKit)
import Foundation
import VellumAssistantShared
import os

private let log = Logger(subsystem: "com.vellum.vellum-assistant", category: "RideShotgunSession")

/// Manages a single Ride Shotgun observation session on iOS.
///
/// Unlike the macOS version this class does not perform any local screen capture —
/// iOS sends `ride_shotgun_start` to the Mac daemon which owns capture. Progress
/// and result messages flow back over the existing SSE connection.
@MainActor
final class RideShotgunSession: ObservableObject, Identifiable {
    let id = UUID()
    enum State: Equatable {
        case idle
        case starting
        case capturing
        case summarizing
        case complete
        case failed(String)
        case cancelled
    }

    @Published var state: State = .idle
    @Published var summary: String = ""
    @Published var observationCount: Int = 0
    @Published var recordingId: String?
    @Published var networkEntryCount: Int = 0
    @Published var statusMessage: String = ""
    @Published var elapsedSeconds: Double = 0
    @Published var captureCount: Int = 0
    @Published var currentApp: String = ""

    let durationSeconds: Int
    let intervalSeconds: Int

    private var daemonClient: (any DaemonClientProtocol)?
    private var messageSubscription: Task<Void, Never>?
    private var elapsedTask: Task<Void, Never>?
    private var expectedWatchId: String?

    init(durationSeconds: Int, intervalSeconds: Int = 10) {
        self.durationSeconds = durationSeconds
        self.intervalSeconds = intervalSeconds
    }

    // MARK: - Lifecycle

    func start(daemonClient: any DaemonClientProtocol) {
        guard state == .idle else {
            log.warning("Cannot start: already in state \(String(describing: self.state))")
            return
        }
        self.daemonClient = daemonClient
        state = .starting

        // Subscribe to daemon messages for watch_started, ride_shotgun_progress, and ride_shotgun_result.
        let stream = daemonClient.subscribe()
        messageSubscription = Task { [weak self] in
            for await message in stream {
                guard let self else { return }
                switch message {
                case .watchStarted(let msg):
                    await MainActor.run { self.handleWatchStarted(msg) }
                case .rideShotgunError(let error):
                    await MainActor.run {
                        guard self.expectedWatchId == nil || error.watchId == self.expectedWatchId else { return }
                        log.error("Ride shotgun bootstrap failure: \(error.message)")
                        self.state = .failed(error.message)
                        self.cleanup()
                    }
                case .rideShotgunProgress(let progress):
                    await MainActor.run {
                        if let count = progress.networkEntryCount {
                            self.networkEntryCount = count
                        }
                        if let msg = progress.statusMessage, !msg.isEmpty {
                            self.statusMessage = msg
                        }
                    }
                case .rideShotgunResult(let result):
                    await MainActor.run { self.handleRideShotgunResult(result) }
                default:
                    break
                }
            }
        }

        // Ask the Mac daemon to start an observation session.
        do {
            try daemonClient.send(RideShotgunStartMessage(
                durationSeconds: Double(durationSeconds),
                intervalSeconds: Double(intervalSeconds)
            ))
            log.info("ride_shotgun_start sent: duration=\(self.durationSeconds)s interval=\(self.intervalSeconds)s")
        } catch {
            log.error("Failed to send ride_shotgun_start: \(error.localizedDescription)")
            state = .failed("Failed to start session")
            cleanup()
        }
    }

    func cancel() {
        // Send ride_shotgun_stop so the daemon terminates the capture session
        // immediately rather than running to timeout.  Use the watchId if we
        // have one; if we cancelled before watch_started arrived, skip the send
        // (the daemon will time out on its own shortly after never receiving
        // any client activity).
        if let watchId = expectedWatchId, let daemonClient {
            do {
                try daemonClient.send(RideShotgunStopMessage(watchId: watchId))
                log.info("ride_shotgun_stop sent on cancel: watchId=\(watchId)")
            } catch {
                log.error("Failed to send ride_shotgun_stop on cancel: \(error.localizedDescription)")
            }
        }
        log.info("Session cancelled")
        state = .cancelled
        cleanup()
    }

    /// Request early stop: the daemon finalises the recording and generates a summary.
    func stopEarly() {
        guard let watchId = expectedWatchId, let daemonClient else {
            log.warning("Cannot stop early: no watchId")
            cancel()
            return
        }
        do {
            try daemonClient.send(RideShotgunStopMessage(watchId: watchId))
            state = .summarizing
            log.info("Requested early stop for watchId=\(watchId)")
        } catch {
            log.error("Failed to send ride_shotgun_stop: \(error.localizedDescription)")
            cancel()
        }
    }

    // MARK: - Incoming message handlers

    private func handleWatchStarted(_ message: WatchStartedMessage) {
        guard state == .starting else { return }
        expectedWatchId = message.watchId
        state = .capturing
        startElapsedTimer()
        log.info("Watch started: watchId=\(message.watchId)")
    }

    private func handleRideShotgunResult(_ result: RideShotgunResultMessage) {
        guard state == .capturing || state == .summarizing else {
            log.warning("Ignoring ride_shotgun_result in state \(String(describing: self.state))")
            return
        }
        guard result.watchId == expectedWatchId else {
            log.warning("Ignoring ride_shotgun_result: watchId mismatch")
            return
        }
        summary = result.summary
        observationCount = result.observationCount
        recordingId = result.recordingId
        elapsedSeconds = Double(durationSeconds)
        state = .complete
        log.info("Session complete: \(result.observationCount) observations")
        cleanup()
    }

    // MARK: - Elapsed timer

    private func startElapsedTimer() {
        elapsedTask?.cancel()
        let started = Date()
        elapsedTask = Task { [weak self] in
            guard let self else { return }
            while !Task.isCancelled {
                let elapsed = min(Date().timeIntervalSince(started), Double(self.durationSeconds))
                await MainActor.run { self.elapsedSeconds = elapsed }
                if elapsed >= Double(self.durationSeconds) { break }
                try? await Task.sleep(nanoseconds: 1_000_000_000)
            }
        }
    }

    // MARK: - Cleanup

    private func cleanup() {
        elapsedTask?.cancel()
        elapsedTask = nil
        messageSubscription?.cancel()
        messageSubscription = nil
    }
}
#endif
