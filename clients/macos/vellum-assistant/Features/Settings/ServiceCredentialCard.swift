import SwiftUI
import VellumAssistantShared

/// A reusable card for Models & Services integrations that need an API key.
///
/// Shows four visual states:
/// - **Not connected (empty)**: API key field with placeholder, Save disabled
/// - **Not connected (key entered)**: API key field with masked input, Save enabled
/// - **Connected**: "Connected" badge inline with title, masked placeholder in key field,
///   Save disabled, "Reset (disconnect)" button visible
/// - **Managed proxy**: "Managed by Vellum" badge inline with title, API key field
///   collapsed under a disclosure ("Override with your own key")
///
/// Pass optional extra content (e.g. a model picker) via the trailing `@ViewBuilder` closure.
struct ServiceCredentialCard<ExtraContent: View>: View {
    let title: String
    let subtitle: String
    let isConnected: Bool
    let keyPlaceholder: String
    let isManagedProxy: Bool
    @Binding var keyText: String
    let onSave: () -> Void
    let onReset: () -> Void
    @ViewBuilder let extraContent: () -> ExtraContent

    @State private var showKeyOverride: Bool = false

    private var isSaveEnabled: Bool {
        let hasNewKey = !keyText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        // Disable Save when connected and no new key has been entered,
        // or when not connected and the field is empty.
        return hasNewKey
    }

    var body: some View {
        VStack(alignment: .leading, spacing: VSpacing.md) {
            // Header: title + connected/managed badge
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
                    } else if isManagedProxy {
                        HStack(spacing: VSpacing.xs) {
                            VIconView(.circleCheck, size: 12)
                            Text("Managed by Vellum")
                                .font(VFont.captionMedium)
                        }
                        .foregroundColor(VColor.primaryBase)
                        .padding(.horizontal, VSpacing.sm)
                        .padding(.vertical, VSpacing.xxs)
                        .background(VColor.primaryBase.opacity(0.12))
                        .clipShape(Capsule())
                    }
                }
                Text(subtitle)
                    .font(VFont.sectionDescription)
                    .foregroundColor(VColor.contentTertiary)
            }

            Divider()
                .background(VColor.borderBase)

            // API Key field — collapsed under disclosure when managed proxy without user key
            if isManagedProxy && !isConnected {
                DisclosureGroup("Override with your own key", isExpanded: $showKeyOverride) {
                    apiKeyField
                        .padding(.top, VSpacing.sm)

                    // Action buttons
                    HStack(spacing: VSpacing.sm) {
                        VButton(label: "Save", style: .primary, isDisabled: !isSaveEnabled) {
                            onSave()
                        }
                    }
                    .padding(.top, VSpacing.sm)
                }
                .font(VFont.inputLabel)
                .foregroundColor(VColor.contentSecondary)
            } else {
                apiKeyField

                extraContent()

                // Action buttons
                HStack(spacing: VSpacing.sm) {
                    VButton(label: "Save", style: .primary, isDisabled: !isSaveEnabled) {
                        onSave()
                    }
                    if isConnected {
                        VButton(label: "Clear", style: .danger) {
                            onReset()
                        }
                    }
                }
            }

            // Extra content shown outside disclosure when managed (e.g. model picker)
            if isManagedProxy && !isConnected {
                extraContent()
            }
        }
        .padding(VSpacing.lg)
        .frame(maxWidth: .infinity, alignment: .leading)
        .vCard(background: VColor.surfaceOverlay)
    }

    private var apiKeyField: some View {
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
    }
}

// MARK: - Convenience init (no extra content)

extension ServiceCredentialCard where ExtraContent == EmptyView {
    init(
        title: String,
        subtitle: String,
        isConnected: Bool,
        keyPlaceholder: String,
        isManagedProxy: Bool = false,
        keyText: Binding<String>,
        onSave: @escaping () -> Void,
        onReset: @escaping () -> Void
    ) {
        self.title = title
        self.subtitle = subtitle
        self.isConnected = isConnected
        self.keyPlaceholder = keyPlaceholder
        self.isManagedProxy = isManagedProxy
        self._keyText = keyText
        self.onSave = onSave
        self.onReset = onReset
        self.extraContent = { EmptyView() }
    }
}

// MARK: - Preview
