import SwiftUI
import VellumAssistantShared

/// A reusable card for Models & Services integrations that need an API key.
///
/// Shows three visual states:
/// - **Not connected (empty)**: API key field with placeholder, Save disabled
/// - **Not connected (key entered)**: API key field with masked input, Save enabled
/// - **Connected**: "Connected" badge inline with title, masked placeholder in key field,
///   Save disabled, "Reset (disconnect)" button visible
///
/// Pass optional extra content (e.g. a model picker) via the trailing `@ViewBuilder` closure.
struct ServiceCredentialCard<ExtraContent: View>: View {
    let title: String
    let subtitle: String
    let isConnected: Bool
    let keyPlaceholder: String
    @Binding var keyText: String
    let onSave: () -> Void
    let onReset: () -> Void
    @ViewBuilder let extraContent: () -> ExtraContent

    private var isSaveEnabled: Bool {
        let hasNewKey = !keyText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        // Disable Save when connected and no new key has been entered,
        // or when not connected and the field is empty.
        return hasNewKey
    }

    var body: some View {
        VStack(alignment: .leading, spacing: VSpacing.md) {
            // Header: title + connected badge
            VStack(alignment: .leading, spacing: VSpacing.sm) {
                HStack(spacing: VSpacing.sm) {
                    Text(title)
                        .font(VFont.sectionTitle)
                        .foregroundColor(VColor.contentDefault)
                    if isConnected {
                        HStack(spacing: VSpacing.xs) {
                            VIconView(.circleCheck, size: 12)
                            Text("Connected")
                                .font(VFont.captionMedium)
                        }
                        .foregroundColor(VColor.systemPositiveStrong)
                        .padding(.horizontal, VSpacing.sm)
                        .padding(.vertical, VSpacing.xxs)
                        .background(VColor.systemPositiveStrong.opacity(0.12))
                        .clipShape(Capsule())
                    }
                }
                Text(subtitle)
                    .font(VFont.sectionDescription)
                    .foregroundColor(VColor.contentTertiary)
            }

            // API Key field
            VStack(alignment: .leading, spacing: VSpacing.sm) {
                Text("API Key")
                    .font(VFont.inputLabel)
                    .foregroundColor(VColor.contentSecondary)
                SecureField(
                    isConnected && keyText.isEmpty
                        ? "••••••••••••••••••••••••••••••••••••••••••••••••••••••••••••••••••••••••••••••••"
                        : keyPlaceholder,
                    text: $keyText
                )
                .vInputStyle()
                .font(VFont.body)
                .foregroundColor(VColor.contentDefault)
            }

            extraContent()

            // Action buttons
            HStack(spacing: VSpacing.sm) {
                VButton(label: "Save", style: .primary, size: .medium, isDisabled: !isSaveEnabled) {
                    onSave()
                }
                if isConnected {
                    VButton(label: "Reset (disconnect)", style: .danger, size: .medium) {
                        onReset()
                    }
                }
            }
        }
        .padding(VSpacing.lg)
        .frame(maxWidth: .infinity, alignment: .leading)
        .vCard(background: VColor.surfaceOverlay)
    }
}

// MARK: - Convenience init (no extra content)

extension ServiceCredentialCard where ExtraContent == EmptyView {
    init(
        title: String,
        subtitle: String,
        isConnected: Bool,
        keyPlaceholder: String,
        keyText: Binding<String>,
        onSave: @escaping () -> Void,
        onReset: @escaping () -> Void
    ) {
        self.title = title
        self.subtitle = subtitle
        self.isConnected = isConnected
        self.keyPlaceholder = keyPlaceholder
        self._keyText = keyText
        self.onSave = onSave
        self.onReset = onReset
        self.extraContent = { EmptyView() }
    }
}

// MARK: - Preview

#Preview("Service Credential Card - Not Connected") {
    ZStack {
        VColor.surfaceOverlay.ignoresSafeArea()
        VStack(spacing: VSpacing.lg) {
            ServiceCredentialCard(
                title: "Anthropic",
                subtitle: "Required for AI responses",
                isConnected: false,
                keyPlaceholder: "Enter your API key",
                keyText: .constant(""),
                onSave: {},
                onReset: {}
            ) {
                VStack(alignment: .leading, spacing: VSpacing.sm) {
                    Text("Active Model")
                        .font(VFont.inputLabel)
                        .foregroundColor(VColor.contentSecondary)
                    VDropdown(
                        placeholder: "Select a model…",
                        selection: .constant("claude-opus-4-6"),
                        options: [(label: "Claude Opus 4.6", value: "claude-opus-4-6")]
                    )
                }
            }

            ServiceCredentialCard(
                title: "Brave Search",
                subtitle: "Enables private web search in responses",
                isConnected: true,
                keyPlaceholder: "Enter your API key",
                keyText: .constant(""),
                onSave: {},
                onReset: {}
            )
        }
        .padding()
    }
    .frame(width: 600, height: 600)
}
