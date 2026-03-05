import SwiftUI
import VellumAssistantShared

/// A reusable row for editable text metadata fields. Shows the current value
/// (or a "+ Add" link when empty) and transforms into an inline editor on click.
struct EditableMetadataRow<Editor: View>: View {
    let label: String
    let value: String?
    @Binding var isEditing: Bool
    var formatValue: (String) -> String = { $0 }
    @ViewBuilder let editor: () -> Editor
    let onStartEditing: () -> Void
    let onCancel: () -> Void

    var body: some View {
        HStack(spacing: VSpacing.sm) {
            Text(label)
                .font(VFont.caption)
                .foregroundColor(VColor.textSecondary)
                .frame(width: 140, alignment: .leading)

            if isEditing {
                HStack(spacing: VSpacing.sm) {
                    editor()

                    Button {
                        onCancel()
                    } label: {
                        Image(systemName: "xmark")
                            .foregroundColor(VColor.textMuted)
                            .font(.system(size: 12, weight: .semibold))
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel("Cancel editing")
                }
            } else if let value, !value.isEmpty {
                Text(formatValue(value))
                    .font(VFont.body)
                    .foregroundColor(VColor.textPrimary)
                    .onTapGesture {
                        onStartEditing()
                        isEditing = true
                    }
            } else {
                Button {
                    onStartEditing()
                    isEditing = true
                } label: {
                    Text("+ Add")
                        .font(VFont.caption)
                        .foregroundColor(VColor.accent)
                }
                .buttonStyle(.plain)
            }

            Spacer()
        }
    }
}
