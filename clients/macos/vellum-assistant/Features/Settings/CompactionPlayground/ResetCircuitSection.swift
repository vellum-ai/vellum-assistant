import SwiftUI
import VellumAssistantShared

/// Reset Circuit subsection of the Compaction Playground tab.
///
/// Drives `CompactionPlaygroundClient.resetCircuit(conversationId:)` to clear
/// the consecutive-failure count and any open circuit on the active
/// conversation. The daemon emits a `compaction_circuit_closed` event on
/// success, which dismisses any active circuit-breaker toast in the UI.
/// No local state display — the StateDisplaySection polls separately; this
/// section only triggers the action.
struct ResetCircuitSection: View {
    let conversationId: String?
    let client: CompactionPlaygroundClient
    let showToast: (String, ToastInfo.Style) -> Void

    @State private var isRunning = false

    var body: some View {
        VStack(alignment: .leading, spacing: VSpacing.sm) {
            Text("Reset Circuit Breaker")
                .font(VFont.titleSmall)
                .foregroundStyle(VColor.contentDefault)
            Text("Clear consecutive-failure count and any open circuit on the active conversation.")
                .font(VFont.bodySmallDefault)
                .foregroundStyle(VColor.contentSecondary)
            VButton(
                label: "Reset Circuit Breaker",
                style: .outlined,
                isDisabled: conversationId == nil || isRunning
            ) {
                Task {
                    guard let id = conversationId else { return }
                    isRunning = true
                    defer { isRunning = false }
                    do {
                        try await client.resetCircuit(conversationId: id)
                        showToast("Circuit breaker cleared.", .success)
                    } catch CompactionPlaygroundError.notAvailable {
                        showToast("Playground endpoints disabled — enable the compaction-playground flag.", .error)
                    } catch {
                        showToast("Reset failed: \(error.localizedDescription)", .error)
                    }
                }
            }
        }
        .padding(VSpacing.lg)
        .frame(maxWidth: .infinity, alignment: .leading)
        .vCard()
    }
}
