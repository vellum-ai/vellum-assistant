import SwiftUI
import VellumAssistantShared

/// Compact assistant chooser embedded in Settings > General > Assistant Version.
/// Rows intentionally use the same `AssistantPickerItem` model as onboarding
/// so labels stay consistent between first login and later switching.
struct AssistantVersionSwitcher: View {
    let items: [AssistantPickerItem]
    let selectedAssistantId: String?
    let switchingAssistantId: String?
    let isLoading: Bool
    let errorMessage: String?
    let onSwitch: (String) -> Void
    let onRefresh: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: VSpacing.sm) {
            HStack(spacing: VSpacing.sm) {
                Text("Assistant")
                    .font(VFont.labelDefault)
                    .foregroundStyle(VColor.contentTertiary)
                    .accessibilityAddTraits(.isHeader)

                if isLoading {
                    ProgressView()
                        .controlSize(.small)
                        .progressViewStyle(.circular)
                }

                Spacer()

                VButton(
                    label: "Refresh assistants",
                    iconOnly: VIcon.refreshCw.rawValue,
                    style: .ghost,
                    size: .compact,
                    tooltip: "Refresh assistants"
                ) {
                    onRefresh()
                }
            }

            VStack(spacing: VSpacing.sm) {
                ForEach(items) { item in
                    assistantRow(item)
                }
            }

            if let errorMessage {
                Text(errorMessage)
                    .font(VFont.labelDefault)
                    .foregroundStyle(VColor.systemNegativeStrong)
            }
        }
    }

    @ViewBuilder
    private func assistantRow(_ item: AssistantPickerItem) -> some View {
        let isSelected = item.id == selectedAssistantId
        let isSwitching = item.id == switchingAssistantId
        HStack(spacing: VSpacing.md) {
            VStack(alignment: .leading, spacing: 2) {
                Text(item.displayName)
                    .font(VFont.titleSmall)
                    .foregroundStyle(VColor.contentDefault)
                    .lineLimit(1)
                    .truncationMode(.middle)

                if let subtitle = item.subtitle {
                    Text(subtitle)
                        .font(VFont.labelDefault)
                        .foregroundStyle(VColor.contentSecondary)
                }
            }

            Spacer(minLength: VSpacing.md)

            if isSwitching {
                ProgressView()
                    .controlSize(.small)
                    .progressViewStyle(.circular)
            } else if isSelected {
                VBadge(label: "Current", tone: .positive, emphasis: .subtle)
            } else {
                VButton(label: "Switch", style: .outlined, size: .compact) {
                    onSwitch(item.id)
                }
                .accessibilityLabel("Switch to \(item.displayName)")
                .disabled(switchingAssistantId != nil)
            }
        }
        .padding(VSpacing.md)
        .background(isSelected ? VColor.surfaceActive : VColor.surfaceOverlay)
        .clipShape(RoundedRectangle(cornerRadius: VRadius.md))
        .overlay(
            RoundedRectangle(cornerRadius: VRadius.md)
                .stroke(isSelected ? VColor.borderActive : VColor.borderBase, lineWidth: 1)
        )
    }
}
