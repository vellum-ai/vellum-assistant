import Foundation
import os

private let log = Logger(subsystem: Bundle.main.bundleIdentifier ?? "com.vellum.vellum-assistant", category: "TerminalSession")

/// Manages the lifecycle of a single PTY terminal session against the platform API.
///
/// Handles connecting, streaming output, buffering input, resizing, reconnecting,
/// and cleaning up sessions. Drives UI state via the published `status` property.
@MainActor
final class TerminalSessionManager: ObservableObject {

    // MARK: - Published State

    enum Status: Equatable {
        case idle
        case connecting
        case connected
        case reconnecting
        case error(String)
        case closed
    }

    @Published private(set) var status: Status = .idle

    // MARK: - Configuration

    private let assistantId: String
    private let apiClient: TerminalAPIClient

    /// Called with base64-encoded PTY output bytes as they arrive from the stream.
    var onData: ((String) -> Void)?

    // MARK: - Session State

    private var sessionId: String?
    private var cancelSSE: (() -> Void)?
    private var sseTask: Task<Void, Never>?

    // Input buffering — batches keystrokes and flushes every 50ms.
    private var inputBuffer: String = ""
    private var inputFlushTimer: Timer?
    private static let inputFlushInterval: TimeInterval = 0.05

    // Resize debouncing — only the last resize within 150ms is sent.
    private var resizeTimer: Timer?
    private var pendingResize: (cols: Int, rows: Int)?
    private var lastDimensions: (cols: Int, rows: Int)?
    private static let resizeDebounceInterval: TimeInterval = 0.15

    // Sequence deduplication for output events.
    private var highWaterMark: Int = -1

    // MARK: - Init

    init(assistantId: String, apiClient: TerminalAPIClient) {
        self.assistantId = assistantId
        self.apiClient = apiClient
    }

    deinit {
        inputFlushTimer?.invalidate()
        resizeTimer?.invalidate()
    }

    // MARK: - Public API

    /// Opens a new terminal session and starts streaming output.
    func connect() {
        guard status == .idle || status == .closed || isError else { return }
        status = .connecting
        openSession(isReconnect: false)
    }

    /// Tears down the current session and opens a fresh one.
    func reconnect() {
        guard status == .connected || isError else { return }
        teardownStream()
        if let sessionId, !assistantId.isEmpty {
            Task { await apiClient.destroySession(assistantId: assistantId, sessionId: sessionId) }
        }
        sessionId = nil
        status = .reconnecting
        openSession(isReconnect: true)
    }

    /// Closes the terminal session cleanly.
    func close() {
        teardownStream()
        if let sessionId, !assistantId.isEmpty {
            let aid = assistantId
            let sid = sessionId
            let client = apiClient
            Task { await client.destroySession(assistantId: aid, sessionId: sid) }
        }
        sessionId = nil
        status = .closed
    }

    /// Buffers keyboard input for batched sending to the PTY.
    func sendInput(_ data: String) {
        inputBuffer += data
    }

    /// Notifies the backend of a terminal window resize (debounced).
    func sendResize(cols: Int, rows: Int) {
        lastDimensions = (cols, rows)

        guard status == .connected, let sessionId else { return }

        pendingResize = (cols, rows)
        resizeTimer?.invalidate()
        resizeTimer = Timer.scheduledTimer(withTimeInterval: Self.resizeDebounceInterval, repeats: false) { [weak self] _ in
            Task { @MainActor [weak self] in
                guard let self, let pending = self.pendingResize, let sid = self.sessionId else { return }
                self.pendingResize = nil
                try? await self.apiClient.resize(
                    assistantId: self.assistantId,
                    sessionId: sid,
                    cols: pending.cols,
                    rows: pending.rows
                )
            }
        }
    }

    // MARK: - Private

    private var isError: Bool {
        if case .error = status { return true }
        return false
    }

    private func openSession(isReconnect: Bool) {
        highWaterMark = -1

        Task { @MainActor in
            do {
                let sid = try await apiClient.createSession(assistantId: assistantId)
                self.sessionId = sid
                self.startSSEStream(sessionId: sid)
                self.startInputFlushTimer(sessionId: sid)
                self.status = .connected

                // Flush last known dimensions so the PTY matches the view.
                if let dims = self.lastDimensions {
                    try? await self.apiClient.resize(
                        assistantId: self.assistantId,
                        sessionId: sid,
                        cols: dims.cols,
                        rows: dims.rows
                    )
                }

                log.info("Terminal session connected: \(sid)")
            } catch {
                let message = error.localizedDescription
                log.error("Terminal session \(isReconnect ? "reconnect" : "connect") failed: \(message)")
                self.status = .error(message)
            }
        }
    }

    private func startSSEStream(sessionId: String) {
        let (stream, cancel) = apiClient.subscribeEvents(assistantId: assistantId, sessionId: sessionId)
        cancelSSE = cancel

        sseTask = Task { @MainActor [weak self] in
            do {
                for try await event in stream {
                    guard let self else { return }
                    if Task.isCancelled { return }

                    // Drop duplicate / out-of-order events
                    guard event.seq > self.highWaterMark else { continue }
                    self.highWaterMark = event.seq
                    self.onData?(event.data)
                }

                // Stream ended without error — treat as unexpected disconnect
                guard let self, !Task.isCancelled else { return }
                self.teardownStream()
                self.status = .error("Terminal stream ended unexpectedly")
            } catch {
                guard let self, !Task.isCancelled else { return }
                self.teardownStream()
                self.status = .error(error.localizedDescription)
            }
        }
    }

    private func startInputFlushTimer(sessionId: String) {
        inputFlushTimer?.invalidate()
        inputFlushTimer = Timer.scheduledTimer(withTimeInterval: Self.inputFlushInterval, repeats: true) { [weak self] _ in
            Task { @MainActor [weak self] in
                guard let self else { return }
                let buffered = self.inputBuffer
                guard !buffered.isEmpty else { return }
                self.inputBuffer = ""
                try? await self.apiClient.sendInput(
                    assistantId: self.assistantId,
                    sessionId: sessionId,
                    data: buffered
                )
            }
        }
    }

    private func teardownStream() {
        cancelSSE?()
        cancelSSE = nil
        sseTask?.cancel()
        sseTask = nil
        inputFlushTimer?.invalidate()
        inputFlushTimer = nil
        inputBuffer = ""
        resizeTimer?.invalidate()
        resizeTimer = nil
        pendingResize = nil
    }
}
