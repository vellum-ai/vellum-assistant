import SwiftUI
import VellumAssistantShared

extension MemoryItemDetailSheet {

    var header: some View {
        HStack(alignment: .center, spacing: VSpacing.sm) {
            Text(displayItem.subject)
                .font(VFont.cardTitle)
                .foregroundColor(VColor.contentDefault)
                .lineLimit(1)

            Spacer()

            if !isEditing {
                HStack(spacing: VSpacing.xs) {
                    VButton(
                        label: "Edit",
                        iconOnly: VIcon.pencil.rawValue,
                        style: .ghost,
                        tooltip: "Edit memory"
                    ) {
                        isEditing = true
                    }

                    VButton(
                        label: "Delete",
                        iconOnly: VIcon.trash.rawValue,
                        style: .dangerGhost,
                        tooltip: "Delete memory"
                    ) {
                        showDeleteConfirm = true
                    }

                    VButton(
                        label: "Close",
                        iconOnly: VIcon.x.rawValue,
                        style: .ghost,
                        tooltip: "Close"
                    ) {
                        onDismiss()
                    }
                }
            } else {
                VButton(
                    label: "Close",
                    iconOnly: VIcon.x.rawValue,
                    style: .ghost,
                    tooltip: "Close"
                ) {
                    onDismiss()
                }
            }
        }
        .padding(.horizontal, VSpacing.xl)
        .padding(.vertical, VSpacing.lg)
    }
}
