import SwiftUI
import VellumAssistantShared

/// Reusable card for services with a Managed/Your Own mode toggle.
///
/// Provides the outer card chrome (title, subtitle, segmented control,
/// divider, action buttons) and delegates mode-specific content to callers
/// via ViewBuilder closures.
@MainActor
struct ServiceModeCard<ManagedContent: View, YourOwnContent: View>: View {
    let title: String
    let subtitle: String
    @Binding var draftMode: String
    let hasChanges: Bool
    let isSaving: Bool
    let onSave: () -> Void
    /// Optional reset action -- shown only in Your Own mode when `showReset` is true.
    let onReset: (() -> Void)?
    let showReset: Bool
    @ViewBuilder let managedContent: () -> ManagedContent
    @ViewBuilder let yourOwnContent: () -> YourOwnContent

    var body: some View {
        VStack(alignment: .leading, spacing: VSpacing.lg) {
            // Header: title + subtitle + mode toggle
            header

            Rectangle()
                .fill(VColor.surfaceBase)
                .frame(height: 1)

            // Mode-specific content
            if draftMode == "managed" {
                managedContent()
            } else {
                yourOwnContent()
            }

            // Action buttons
            actionButtons
        }
        .padding(VSpacing.lg)
        .frame(maxWidth: .infinity, alignment: .leading)
        .vCard(radius: VRadius.xl, background: VColor.surfaceOverlay)
    }

    // MARK: - Header

    private var header: some View {
        VStack(alignment: .leading, spacing: VSpacing.xs) {
            HStack {
                Text(title)
                    .font(VFont.sectionTitle)
                    .foregroundColor(VColor.contentEmphasized)
                Spacer()
                VSegmentedControl(
                    items: [
                        (label: "Managed", tag: "managed"),
                        (label: "Your Own", tag: "your-own"),
                    ],
                    selection: $draftMode,
                    style: .pill
                )
                .frame(width: 220)
            }
            Text(subtitle)
                .font(VFont.sectionDescription)
                .foregroundColor(VColor.contentTertiary)
        }
    }

    // MARK: - Action Buttons

    private var actionButtons: some View {
        HStack(spacing: VSpacing.sm) {
            if draftMode == "managed" {
                VButton(
                    label: isSaving ? "Saving..." : "Save",
                    style: .primary,
                    isDisabled: !hasChanges || isSaving
                ) { onSave() }
            } else {
                VButton(
                    label: isSaving ? "Validating..." : "Save",
                    style: .primary,
                    isDisabled: !hasChanges || isSaving
                ) { onSave() }
                if showReset, let onReset {
                    VButton(label: "Reset", style: .danger, isDisabled: isSaving) {
                        onReset()
                    }
                }
            }
        }
    }
}
