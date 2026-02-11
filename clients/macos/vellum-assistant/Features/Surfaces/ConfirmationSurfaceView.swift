import SwiftUI

struct ConfirmationSurfaceView: View {
    let data: ConfirmationSurfaceData
    let onAction: (String) -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: VSpacing.lg) {
            // Header with icon
            HStack(spacing: VSpacing.md) {
                Image(systemName: "exclamationmark.triangle.fill")
                    .font(.title2)
                    .foregroundStyle(data.destructive ? VColor.error : VColor.warning)
                Text(data.message)
                    .font(VFont.headline)
                    .foregroundColor(VColor.textPrimary)
            }

            // Detail text
            if let detail = data.detail {
                Text(detail)
                    .font(VFont.body)
                    .foregroundColor(VColor.textSecondary)
            }

            // Action buttons
            HStack(spacing: VSpacing.lg) {
                Spacer()

                VButton(
                    label: data.cancelLabel ?? "Cancel",
                    style: .ghost
                ) {
                    onAction("cancel")
                }

                VButton(
                    label: data.confirmLabel ?? "Confirm",
                    style: data.destructive ? .danger : .primary
                ) {
                    onAction("confirm")
                }
            }
        }
    }
}
