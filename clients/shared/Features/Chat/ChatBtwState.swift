import Foundation
import os

/// Self-contained @Observable state for the BTW (by-the-way) side-chain.
///
/// Owns the streaming lifecycle (send / cancel / dismiss) and the tracked
/// properties that drive the BTW UI. Has no dependency on ChatViewModel —
/// the caller passes the current conversation key at each send call.
@MainActor @Observable
final class ChatBtwState {

    // MARK: - Tracked properties

    /// The accumulated response text from a /btw side-chain query, or nil when inactive.
    var btwResponse: String?
    /// True while a /btw request is in flight.
    var btwLoading: Bool = false

    // MARK: - Internal (untracked)

    /// The in-flight btw streaming task, stored for cancellation.
    @ObservationIgnored
    private var btwTask: Task<Void, Never>?

    // MARK: - Dependencies

    @ObservationIgnored
    private let btwClient: any BtwClientProtocol

    // MARK: - Init

    init(btwClient: any BtwClientProtocol) {
        self.btwClient = btwClient
    }

    // MARK: - Public API

    /// Send a /btw side-chain question and stream the response into `btwResponse`.
    func sendBtwMessage(question: String, conversationKey: String) {
        guard !question.isEmpty else { return }

        // Cancel any in-flight btw task to prevent interleaved deltas.
        btwTask?.cancel()

        btwLoading = true
        btwResponse = ""

        btwTask = Task { @MainActor [weak self] in
            guard let self else { return }
            do {
                let stream = self.btwClient.sendMessage(
                    content: question,
                    conversationKey: conversationKey
                )
                for try await delta in stream {
                    guard !Task.isCancelled else { return }
                    self.btwResponse = (self.btwResponse ?? "") + delta
                }
            } catch is CancellationError {
                // Stream was cancelled via dismiss — no error to show.
            } catch {
                guard !Task.isCancelled else { return }
                self.btwResponse = "Failed to get response: \(error.localizedDescription)"
            }
            guard !Task.isCancelled else { return }
            self.btwLoading = false
        }
    }

    /// Clear btw side-chain state and cancel any in-flight stream.
    func dismissBtw() {
        btwTask?.cancel()
        btwTask = nil
        btwResponse = nil
        btwLoading = false
    }

    deinit {
        btwTask?.cancel()
    }
}
