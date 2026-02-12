import SwiftUI

struct ConfirmationSurfaceView: View {
    let data: ConfirmationSurfaceData
    let actions: [SurfaceActionButton]
    let onAction: (String) -> Void

    /// The action ID to emit when the user cancels.
    /// Uses the first server-provided action ID if exactly 2 actions are defined, otherwise defaults to "cancel".
    private var cancelActionId: String {
        if actions.count == 2 {
            return actions[0].id
        }
        return "cancel"
    }

    /// The action ID to emit when the user confirms.
    /// Uses the second server-provided action ID if exactly 2 actions are defined, otherwise defaults to "confirm".
    private var confirmActionId: String {
        if actions.count == 2 {
            return actions[1].id
        }
        return "confirm"
    }

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
                    onAction(cancelActionId)
                }

                VButton(
                    label: data.confirmLabel ?? "Confirm",
                    style: data.destructive ? .danger : .primary
                ) {
                    onAction(confirmActionId)
                }
            }
        }
    }
}

#Preview("Default") {
    ConfirmationSurfaceView(
        data: ConfirmationSurfaceData(
            message: "Delete this file?",
            detail: "This action cannot be undone. The file will be permanently removed.",
            confirmLabel: "Delete",
            cancelLabel: "Keep",
            destructive: true
        ),
        actions: [
            SurfaceActionButton(id: "cancel", label: "Keep", style: .secondary),
            SurfaceActionButton(id: "confirm", label: "Delete", style: .destructive),
        ],
        onAction: { _ in }
    )
    .padding()
}

#Preview("Non-destructive") {
    ConfirmationSurfaceView(
        data: ConfirmationSurfaceData(
            message: "Submit this form?",
            detail: "Your responses will be sent to the server.",
            confirmLabel: nil,
            cancelLabel: nil,
            destructive: false
        ),
        actions: [],
        onAction: { _ in }
    )
    .padding()
}
