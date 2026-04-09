import SwiftUI
import VellumAssistantShared

struct ConversationHostAccessControlConfiguration {
    let isEnabled: Bool
    let canToggle: Bool
    let isUpdating: Bool
    let subtitle: String
    let errorMessage: String?
    let onToggle: () -> Void
}

struct ConversationHostAccessControl: View {
    let configuration: ConversationHostAccessControlConfiguration

    var body: some View {
        VStack(alignment: .leading, spacing: VSpacing.xs) {
            HStack(spacing: VSpacing.md) {
                VIconView(configuration.isEnabled ? .terminal : .lock, size: 14)
                    .foregroundStyle(configuration.isEnabled ? VColor.systemPositiveStrong : VColor.contentSecondary)

                VStack(alignment: .leading, spacing: VSpacing.xxs) {
                    Text("Computer access")
                        .font(VFont.bodyMediumDefault)
                        .foregroundStyle(VColor.contentEmphasized)

                    Text(configuration.subtitle)
                        .font(VFont.labelDefault)
                        .foregroundStyle(VColor.contentTertiary)
                }

                Spacer(minLength: VSpacing.md)

                Toggle(
                    "",
                    isOn: Binding(
                        get: { configuration.isEnabled },
                        set: { _ in configuration.onToggle() }
                    )
                )
                .toggleStyle(.switch)
                .labelsHidden()
                .controlSize(.small)
                .tint(VColor.systemPositiveStrong)
                .disabled(!configuration.canToggle || configuration.isUpdating)
            }

            if let errorMessage = configuration.errorMessage {
                Text(errorMessage)
                    .font(VFont.labelDefault)
                    .foregroundStyle(VColor.systemNegativeStrong)
            }
        }
        .padding(.horizontal, VSpacing.lg)
        .padding(.vertical, VSpacing.sm)
        .frame(maxWidth: VSpacing.chatColumnMaxWidth)
        .frame(maxWidth: .infinity)
        .background(
            RoundedRectangle(cornerRadius: VRadius.lg)
                .fill(VColor.surfaceOverlay.opacity(0.7))
                .overlay(
                    RoundedRectangle(cornerRadius: VRadius.lg)
                        .stroke(VColor.borderBase.opacity(0.6), lineWidth: 1)
                )
        )
        .accessibilityElement(children: .combine)
        .accessibilityLabel("Computer access")
        .accessibilityValue(configuration.isEnabled ? "Enabled" : "Disabled")
    }
}
