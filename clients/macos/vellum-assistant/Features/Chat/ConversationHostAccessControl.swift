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
                ZStack {
                    Circle()
                        .fill(configuration.isEnabled
                            ? VColor.systemPositiveStrong.opacity(0.12)
                            : VColor.contentSecondary.opacity(0.08))
                        .frame(width: 30, height: 30)

                    VIconView(configuration.isEnabled ? .terminal : .lock, size: 14)
                        .foregroundStyle(configuration.isEnabled
                            ? VColor.systemPositiveStrong
                            : VColor.contentSecondary)
                }

                VStack(alignment: .leading, spacing: VSpacing.xxs) {
                    Text("Computer access")
                        .font(VFont.bodyMediumEmphasised)
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
                HStack(spacing: VSpacing.xs) {
                    VIconView(.triangleAlert, size: 11)
                    Text(errorMessage)
                        .font(VFont.labelDefault)
                }
                .foregroundStyle(VColor.systemNegativeStrong)
            }
        }
        .padding(.horizontal, VSpacing.lg)
        .padding(.vertical, VSpacing.md)
        .frame(maxWidth: VSpacing.chatColumnMaxWidth)
        .frame(maxWidth: .infinity)
        .background(
            RoundedRectangle(cornerRadius: VRadius.lg)
                .fill(VColor.surfaceLift.opacity(0.5))
                .overlay(
                    RoundedRectangle(cornerRadius: VRadius.lg)
                        .stroke(
                            configuration.isEnabled
                                ? VColor.systemPositiveStrong.opacity(0.15)
                                : VColor.borderBase.opacity(0.3),
                            lineWidth: 1
                        )
                )
        )
        .animation(.easeInOut(duration: 0.2), value: configuration.isEnabled)
        .accessibilityElement(children: .combine)
        .accessibilityLabel("Computer access")
        .accessibilityValue(configuration.isEnabled ? "Enabled" : "Disabled")
    }
}
