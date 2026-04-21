import SwiftUI
import VellumAssistantShared

/// Force Compact subsection of the Compaction Playground tab.
///
/// Triggers `CompactionPlaygroundClient.forceCompact(conversationId:)` on the
/// active conversation and renders before/after token counts, messages removed,
/// and a `summaryFailed` indicator. A 404 from the flat `/playground/*` route
/// surface (``CompactionPlaygroundError/notAvailable``) is surfaced with a
/// distinctive "playground endpoints disabled" message so the dev can tell
/// "flag off" apart from other failures.
struct ForceCompactSection: View {
    let conversationId: String?
    let client: CompactionPlaygroundClient
    let showToast: (String, ToastInfo.Style) -> Void

    @State private var isRunning = false
    @State private var lastResult: CompactionForceResponse?
    @State private var lastError: String?

    var body: some View {
        VStack(alignment: .leading, spacing: VSpacing.sm) {
            Text("Force Compact")
                .font(VFont.titleSmall)
                .foregroundStyle(VColor.contentDefault)

            Text("Trigger compaction on the active conversation immediately.")
                .font(VFont.bodySmallDefault)
                .foregroundStyle(VColor.contentSecondary)

            VButton(
                label: isRunning ? "Force Compacting..." : "Force Compact Now",
                style: .outlined,
                isDisabled: conversationId == nil || isRunning
            ) {
                runForceCompact()
            }

            if isRunning {
                HStack(spacing: VSpacing.sm) {
                    ProgressView()
                        .controlSize(.small)
                    Text("Compacting...")
                        .font(VFont.labelDefault)
                        .foregroundStyle(VColor.contentTertiary)
                }
            }

            if let result = lastResult {
                resultPanel(result)
            } else if let error = lastError {
                Text(error)
                    .font(VFont.bodySmallDefault)
                    .foregroundStyle(VColor.systemNegativeStrong)
            }
        }
        .padding(VSpacing.lg)
        .frame(maxWidth: .infinity, alignment: .leading)
        .vCard()
    }

    @ViewBuilder
    private func resultPanel(_ result: CompactionForceResponse) -> some View {
        VStack(alignment: .leading, spacing: VSpacing.xs) {
            Text("Compacted: \(result.compacted ? "yes" : "no")")
                .font(VFont.bodySmallDefault)
                .foregroundStyle(result.compacted ? VColor.systemPositiveStrong : VColor.systemNegativeStrong)

            Text("Tokens: \(result.previousTokens) → \(result.newTokens)")
                .font(VFont.bodySmallDefault)
                .foregroundStyle(VColor.contentSecondary)

            Text("Messages removed: \(result.messagesRemoved)")
                .font(VFont.bodySmallDefault)
                .foregroundStyle(VColor.contentSecondary)

            if result.summaryFailed == true {
                Text("Summary failed")
                    .font(VFont.bodySmallDefault)
                    .foregroundStyle(VColor.systemNegativeStrong)
            }
        }
    }

    private func runForceCompact() {
        Task {
            guard let id = conversationId else { return }
            isRunning = true
            lastError = nil
            defer { isRunning = false }
            do {
                let result = try await client.forceCompact(conversationId: id)
                lastResult = result
                showToast("Compaction completed.", .success)
            } catch CompactionPlaygroundError.notAvailable {
                let message = "Playground endpoints disabled — enable the compaction-playground flag."
                lastError = message
                lastResult = nil
                showToast(message, .error)
            } catch {
                lastError = error.localizedDescription
                lastResult = nil
                showToast("Compaction failed: \(error.localizedDescription)", .error)
            }
        }
    }
}
