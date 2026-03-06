#if canImport(UIKit)
import SwiftUI
import VellumAssistantShared

/// Sheet shown after a Ride Shotgun session completes, displaying the
/// assistant's observations and offering to start a follow-up chat.
struct RideShotgunSummarySheet: View {
    let summary: AmbientAgentManager.CompletedSummary
    let onDismiss: () -> Void
    let onStartChat: (String) -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: VSpacing.lg) {
            // Header
            HStack {
                VIconView(summary.recordingId != nil ? .circle : .binoculars, size: 16)
                    .foregroundStyle(VColor.accent)
                    .accessibilityHidden(true)
                Text(summary.recordingId != nil ? "Recording saved" : "Here's what I noticed")
                    .font(VFont.headline)
                    .foregroundStyle(VColor.textPrimary)
                Spacer()
                Button {
                    onDismiss()
                } label: {
                    VIconView(.circleX, size: 22)
                        .foregroundStyle(VColor.textMuted)
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Dismiss summary")
            }

            if summary.recordingId != nil {
                Text("Recording saved — ask me to build a skill from it")
                    .font(VFont.caption)
                    .foregroundStyle(VColor.accent)
            }

            // Summary text
            ScrollView {
                Text(summary.text)
                    .font(VFont.body)
                    .foregroundStyle(VColor.textSecondary)
                    .textSelection(.enabled)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }

            // Action buttons
            HStack(spacing: VSpacing.md) {
                Button {
                    onDismiss()
                } label: {
                    Text("Dismiss")
                        .frame(maxWidth: .infinity)
                }
                .buttonStyle(.bordered)

                Button {
                    onStartChat(summary.text)
                } label: {
                    Text(summary.recordingId != nil ? "Build a skill" : "Help me with something")
                        .frame(maxWidth: .infinity)
                }
                .buttonStyle(.borderedProminent)
                .tint(VColor.accent)
            }
        }
        .padding(VSpacing.xl)
        .presentationDetents([.medium, .large])
        .presentationDragIndicator(.visible)
    }
}

#Preview {
    let summary = AmbientAgentManager.CompletedSummary(
        text: "You spent most of the session in Xcode working on a Swift project. I noticed you repeatedly opened the same file — building a shortcut for that could save meaningful time.",
        recordingId: nil
    )
    return Color.clear
        .sheet(isPresented: .constant(true)) {
            RideShotgunSummarySheet(
                summary: summary,
                onDismiss: {},
                onStartChat: { _ in }
            )
        }
}
#endif
