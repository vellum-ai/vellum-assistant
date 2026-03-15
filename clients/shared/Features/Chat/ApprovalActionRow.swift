import SwiftUI

/// Shared action button used across approval UIs (tool confirmation, guardian decisions).
/// Provides consistent styling for primary, danger, and secondary button variants.
public struct ApprovalActionButton: View {
    public let label: String
    public let isPrimary: Bool
    public let isDanger: Bool
    public var isKeyboardSelected: Bool = false
    public let action: () -> Void

    public init(
        label: String,
        isPrimary: Bool = false,
        isDanger: Bool = false,
        isKeyboardSelected: Bool = false,
        action: @escaping () -> Void
    ) {
        self.label = label
        self.isPrimary = isPrimary
        self.isDanger = isDanger
        self.isKeyboardSelected = isKeyboardSelected
        self.action = action
    }

    public var body: some View {
        Button(action: action) {
            Text(label)
                .font(VFont.caption)
                .foregroundColor(isPrimary || isDanger ? VColor.auxWhite : VColor.contentSecondary)
                .padding(.horizontal, VSpacing.sm)
                .padding(.vertical, VSpacing.xxs + 1)
                .background(isDanger ? VColor.systemNegativeStrong : isPrimary ? VColor.primaryBase : Color.clear)
                .clipShape(RoundedRectangle(cornerRadius: VRadius.sm))
                .overlay(
                    RoundedRectangle(cornerRadius: VRadius.sm)
                        .stroke(
                            isKeyboardSelected ? VColor.primaryBase : (isPrimary || isDanger ? Color.clear : VColor.borderBase),
                            lineWidth: isKeyboardSelected ? 2 : 1
                        )
                )
        }
        .buttonStyle(.plain)
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
