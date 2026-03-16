import SwiftUI

/// Shared action button used across approval UIs (tool confirmation, guardian decisions).
/// Provides consistent styling for primary, danger, and secondary button variants.
public struct ApprovalActionButton: View {
    public let label: String
    public let isPrimary: Bool
    public let isDanger: Bool
    public let isDangerOutline: Bool
    public var isKeyboardSelected: Bool = false
    public let action: () -> Void

    public init(
        label: String,
        isPrimary: Bool = false,
        isDanger: Bool = false,
        isDangerOutline: Bool = false,
        isKeyboardSelected: Bool = false,
        action: @escaping () -> Void
    ) {
        self.label = label
        self.isPrimary = isPrimary
        self.isDanger = isDanger
        self.isDangerOutline = isDangerOutline
        self.isKeyboardSelected = isKeyboardSelected
        self.action = action
    }

    private var foregroundColor: Color {
        if isDangerOutline { return VColor.systemNegativeStrong }
        if isPrimary || isDanger { return VColor.auxWhite }
        return VColor.contentSecondary
    }

    private var backgroundColor: Color {
        if isDangerOutline { return Color.clear }
        if isDanger { return VColor.systemNegativeStrong }
        if isPrimary { return VColor.primaryBase }
        return Color.clear
    }

    private var borderColor: Color {
        if isKeyboardSelected { return VColor.primaryBase }
        if isDangerOutline { return VColor.systemNegativeStrong }
        if isPrimary || isDanger { return Color.clear }
        return VColor.borderBase
    }

    public var body: some View {
        Button(action: action) {
            Text(label)
                .font(VFont.caption)
                .foregroundColor(foregroundColor)
                .padding(.horizontal, VSpacing.sm)
                .padding(.vertical, VSpacing.xxs + 1)
                .background(backgroundColor)
                .clipShape(RoundedRectangle(cornerRadius: VRadius.sm))
                .overlay(
                    RoundedRectangle(cornerRadius: VRadius.sm)
                        .stroke(
                            borderColor,
                            lineWidth: isKeyboardSelected ? 2 : 1
                        )
                )
        }
        .buttonStyle(.plain)
        .pointerCursor()
        .accessibilityLabel(label)
    }
}

/// A horizontal row of action buttons for guardian decision prompts.
/// Renders each `GuardianActionOption` with approve/deny styling conventions.
public struct GuardianApprovalActionRow: View {
    public let actions: [GuardianActionOption]
    public let isSubmitting: Bool
    public let onAction: (String) -> Void

    public init(
        actions: [GuardianActionOption],
        isSubmitting: Bool = false,
        onAction: @escaping (String) -> Void
    ) {
        self.actions = actions
        self.isSubmitting = isSubmitting
        self.onAction = onAction
    }

    public var body: some View {
        VStack(alignment: .leading, spacing: VSpacing.xs) {
            HStack(spacing: VSpacing.xs) {
                ForEach(actions, id: \.action) { actionOption in
                    ApprovalActionButton(
                        label: actionOption.label,
                        isPrimary: actionOption.action.hasPrefix("approve") || actionOption.action == "allow",
                        isDanger: actionOption.action == "deny" || actionOption.action == "reject"
                    ) {
                        onAction(actionOption.action)
                    }
                }
                Spacer()
            }
            .opacity(isSubmitting ? 0.5 : 1.0)
            .allowsHitTesting(!isSubmitting)

            if isSubmitting {
                HStack(spacing: VSpacing.xs) {
                    ProgressView()
                        .controlSize(.small)
                    Text("Submitting...")
                        .font(VFont.caption)
                        .foregroundColor(VColor.contentTertiary)
                }
            }
        }
    }
}
