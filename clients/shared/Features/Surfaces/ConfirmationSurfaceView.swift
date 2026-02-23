import SwiftUI

public struct ConfirmationSurfaceView: View {
    public let data: ConfirmationSurfaceData
    public let actions: [SurfaceActionButton]
    public let onAction: (String) -> Void

    public init(data: ConfirmationSurfaceData, actions: [SurfaceActionButton], onAction: @escaping (String) -> Void) {
        self.data = data
        self.actions = actions
        self.onAction = onAction
    }

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

    public var body: some View {
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
                    style: .tertiary
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
