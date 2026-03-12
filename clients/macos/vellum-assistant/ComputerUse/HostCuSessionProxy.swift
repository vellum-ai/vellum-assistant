import Combine
import Foundation
import VellumAssistantShared
import os

private let log = Logger(subsystem: Bundle.main.bundleIdentifier ?? "com.vellum.vellum-assistant", category: "HostCuSessionProxy")

/// States tracked by the session overlay UI.
enum SessionState: Equatable {
    case idle
    case running(step: Int, maxSteps: Int, lastAction: String, reasoning: String)
    case thinking(step: Int, maxSteps: Int)
    case paused(step: Int, maxSteps: Int)
    case awaitingConfirmation(reason: String)
    case completed(summary: String, steps: Int)
    case responded(answer: String, steps: Int)
    case failed(reason: String)
    case cancelled
}

/// Protocol that abstracts the session interface needed by `SessionOverlayWindow`.
/// `HostCuSessionProxy` conforms to this protocol so the overlay can display proxy CU progress.
@MainActor
protocol SessionOverlayProviding: AnyObject {
    var task: String { get }
    var state: SessionState { get set }
    var undoCount: Int { get set }
    var autoApproveTools: Bool { get set }
    var pendingUserGuidance: String? { get set }

    var statePublisher: Published<SessionState>.Publisher { get }
    var undoCountPublisher: Published<Int>.Publisher { get }
    var autoApproveToolsPublisher: Published<Bool>.Publisher { get }

    func cancel()
    func pause()
    func resume()
    func undo()
    func approveConfirmation()
    func rejectConfirmation()
}

/// Lightweight state tracker for proxy-based CU sessions.
/// Provides the `SessionOverlayProviding` interface so
/// `SessionOverlayWindow` can display proxy CU progress.
@MainActor
final class HostCuSessionProxy: ObservableObject, SessionOverlayProviding {
    @Published var state: SessionState = .idle
    @Published var undoCount: Int = 0
    @Published var autoApproveTools: Bool = false
    @Published var pendingUserGuidance: String?

    let task: String
    let sessionId: String

    /// Callback invoked when the user cancels via the overlay.
    /// The AppDelegate wires this to abort the main session.
    var onCancel: (() -> Void)?

    var statePublisher: Published<SessionState>.Publisher { $state }
    var undoCountPublisher: Published<Int>.Publisher { $undoCount }
    var autoApproveToolsPublisher: Published<Bool>.Publisher { $autoApproveTools }

    init(task: String, sessionId: String) {
        self.task = task
        self.sessionId = sessionId
    }

    func cancel() {
        state = .cancelled
        onCancel?()
    }

    func pause() {
        // Pause is not supported in proxy mode — the daemon controls pacing.
        log.info("Pause requested in proxy CU mode — not supported")
    }

    func resume() {
        // Resume is not supported in proxy mode.
        log.info("Resume requested in proxy CU mode — not supported")
    }

    func undo() {
        // Undo is not meaningful in proxy mode since we don't own the action loop.
        log.info("Undo requested in proxy CU mode — not supported")
    }

    func approveConfirmation() {
        // Confirmation is handled server-side in proxy mode.
    }

    func rejectConfirmation() {
        cancel()
    }
}
