import SwiftUI
import VellumAssistantShared

/// Reusable card for services with a Managed/Your Own mode toggle.
///
/// Provides the outer card chrome (title, subtitle, segmented control,
/// divider) and delegates mode-specific content — including any action
/// buttons — to callers via ViewBuilder closures. Each card is responsible
/// for placing its own save/reset actions contextually within its content.
@MainActor
struct ServiceModeCard<ManagedContent: View, YourOwnContent: View, Footer: View>: View {
    let title: String
    let subtitle: String
    @Binding var draftMode: String
    @ViewBuilder let managedContent: () -> ManagedContent
    @ViewBuilder let yourOwnContent: () -> YourOwnContent
    @ViewBuilder let footer: () -> Footer

    var body: some View {
        VStack(alignment: .leading, spacing: VSpacing.lg) {
            // Header: title + subtitle + mode toggle
            header

            Rectangle()
                .fill(VColor.surfaceBase)
                .frame(height: 1)

            // Mode-specific content (including any action buttons)
            if draftMode == "managed" {
                managedContent()
            } else {
                yourOwnContent()
            }

            footer()
        }
        .padding(VSpacing.lg)
        .frame(maxWidth: .infinity, alignment: .leading)
        .vCard(radius: VRadius.xl)
    }

    // MARK: - Header

    private var header: some View {
        VStack(alignment: .leading, spacing: VSpacing.xs) {
            HStack {
                VStack(alignment: .leading, spacing: VSpacing.xs) {
                    Text(title)
                        .font(VFont.titleSmall)
                        .foregroundStyle(VColor.contentEmphasized)
                    Text(subtitle)
                        .font(VFont.bodyMediumDefault)
                        .foregroundStyle(VColor.contentTertiary)
                }
                Spacer()
                VSegmentControl(
                    items: [
                        (label: "Managed", tag: "managed"),
                        (label: "Your Own", tag: "your-own"),
                    ],
                    selection: $draftMode
                )
                .frame(width: 220)
            }
        }
    }
}

extension ServiceModeCard where Footer == EmptyView {
    init(
        title: String,
        subtitle: String,
        draftMode: Binding<String>,
        @ViewBuilder managedContent: @escaping () -> ManagedContent,
        @ViewBuilder yourOwnContent: @escaping () -> YourOwnContent
    ) {
        self.title = title
        self.subtitle = subtitle
        self._draftMode = draftMode
        self.managedContent = managedContent
        self.yourOwnContent = yourOwnContent
        self.footer = { EmptyView() }
    }
}

// MARK: - Reusable Action Buttons

/// Reusable save/reset action buttons for service cards.
///
/// Use this within service card content closures to provide consistent
/// action button styling without duplicating button logic across cards.
@MainActor
struct ServiceCardActions: View {
    let hasChanges: Bool
    var isSaving: Bool = false
    let onSave: () -> Void
    var saveLabel: String = "Save"
    var savingLabel: String = "Saving..."
    var onReset: (() -> Void)? = nil
    var showReset: Bool = false

    var body: some View {
        HStack(spacing: VSpacing.sm) {
            VButton(
                label: isSaving ? savingLabel : saveLabel,
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

/// A picker (dropdown) with an inline save button that adapts to available width.
///
/// At wider sizes, the save button sits to the right of the dropdown. At narrow
/// widths, it falls below the dropdown via `VAdaptiveStack`.
@MainActor
struct PickerWithInlineSave<PickerContent: View>: View {
    let hasChanges: Bool
    var isSaving: Bool = false
    let onSave: () -> Void
    var saveLabel: String = "Save"
    var savingLabel: String = "Saving..."
    @ViewBuilder let picker: () -> PickerContent

    var body: some View {
        VAdaptiveStack(horizontalAlignment: .bottom) {
            picker()
            VButton(
                label: isSaving ? savingLabel : saveLabel,
                style: .primary,
                isDisabled: !hasChanges || isSaving
            ) { onSave() }
        }
    }
}
