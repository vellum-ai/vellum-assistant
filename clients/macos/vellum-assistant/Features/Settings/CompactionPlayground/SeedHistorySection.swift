import SwiftUI
import VellumAssistantShared

/// Seed History subsection of the Compaction Playground tab.
///
/// Drives `CompactionPlaygroundClient.seedConversation(...)` and, on success,
/// renders a result panel with an "Open Conversation" button that deep-links
/// into the newly seeded conversation via `conversationManager` and dismisses
/// the Settings window via `onClose`.
///
/// Validation is client-side so the user gets immediate feedback and the
/// endpoint is not hit with obviously bad input:
/// - `turns` must parse as a positive Int no larger than 500.
/// - `avgTokensPerTurn` must parse as a positive Int no larger than 5000.
struct SeedHistorySection: View {
    let conversationId: String?
    let client: CompactionPlaygroundClient
    let conversationManager: ConversationManager
    let showToast: (String, ToastInfo.Style) -> Void
    let onClose: () -> Void

    @State private var turnsInput: String = "50"
    @State private var avgTokensInput: String = "500"
    @State private var titleInput: String = ""
    @State private var isRunning = false
    @State private var lastResult: SeedConversationResponse?
    @State private var validationError: String?

    private static let maxTurns = 500
    private static let maxAvgTokens = 5_000

    var body: some View {
        VStack(alignment: .leading, spacing: VSpacing.sm) {
            Text("Seed History")
                .font(VFont.titleSmall)
                .foregroundStyle(VColor.contentDefault)

            Text("Create a new conversation with N synthetic user/assistant message pairs, ready for compaction testing.")
                .font(VFont.bodySmallDefault)
                .foregroundStyle(VColor.contentSecondary)

            VTextField(
                "Turns",
                placeholder: "50",
                text: $turnsInput
            )

            VTextField(
                "Avg tokens per turn",
                placeholder: "500",
                text: $avgTokensInput
            )

            VTextField(
                "Title (optional)",
                placeholder: "Leave blank for timestamp",
                text: $titleInput
            )

            if let validationError {
                VNotification(validationError, tone: .negative)
            }

            VButton(
                label: "Seed New Conversation",
                style: .primary,
                isDisabled: isRunning
            ) {
                seedTapped()
            }

            if let result = lastResult {
                resultPanel(result)
            }
        }
        .padding(VSpacing.lg)
        .frame(maxWidth: .infinity, alignment: .leading)
        .vCard()
    }

    // MARK: - Result panel

    @ViewBuilder
    private func resultPanel(_ result: SeedConversationResponse) -> some View {
        VStack(alignment: .leading, spacing: VSpacing.sm) {
            Text("Created \(result.conversationId) — \(result.messagesInserted) messages (~\(result.estimatedTokens) tokens)")
                .font(VFont.bodySmallDefault)
                .foregroundStyle(VColor.contentDefault)
                .textSelection(.enabled)

            VButton(label: "Open Conversation", style: .outlined) {
                openSeededConversation(result.conversationId)
            }
        }
        .padding(.top, VSpacing.xs)
    }

    // MARK: - Actions

    private func seedTapped() {
        guard let turns = parsePositiveInt(turnsInput, max: Self.maxTurns) else {
            validationError = "Turns must be a positive whole number no greater than \(Self.maxTurns)."
            return
        }

        guard let avgTokens = parsePositiveInt(avgTokensInput, max: Self.maxAvgTokens) else {
            validationError = "Avg tokens per turn must be a positive whole number no greater than \(Self.maxAvgTokens)."
            return
        }

        validationError = nil
        let trimmedTitle = titleInput.trimmingCharacters(in: .whitespaces)
        let titleParam: String? = trimmedTitle.isEmpty ? nil : trimmedTitle

        isRunning = true
        Task {
            defer { isRunning = false }
            do {
                let result = try await client.seedConversation(
                    turns: turns,
                    avgTokensPerTurn: avgTokens,
                    title: titleParam
                )
                lastResult = result
                showToast("Seeded conversation created.", .success)
            } catch CompactionPlaygroundError.notAvailable {
                showToast("Playground endpoints disabled — enable the compaction-playground flag.", .error)
            } catch {
                showToast("Seed failed: \(error.localizedDescription)", .error)
            }
        }
    }

    private func openSeededConversation(_ conversationId: String) {
        Task {
            let found = await conversationManager.selectConversationByConversationIdAsync(conversationId)
            if !found {
                showToast("Could not open conversation — refresh the conversation list and try again.", .error)
                return
            }
            onClose()
        }
    }

    // MARK: - Validation

    /// Parses `input` as a positive `Int` in the range `1...max`. Returns
    /// `nil` for non-numeric input, negatives, zero, or values exceeding
    /// `max`.
    private func parsePositiveInt(_ input: String, max: Int) -> Int? {
        let trimmed = input.trimmingCharacters(in: .whitespaces)
        guard let value = Int(trimmed), value > 0, value <= max else { return nil }
        return value
    }
}
