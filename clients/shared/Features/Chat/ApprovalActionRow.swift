import SwiftUI

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
                    VButton(
                        label: actionOption.label,
                        style: Self.buttonStyle(for: actionOption.action),
                        size: .compact
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
                        .font(VFont.labelDefault)
                        .foregroundColor(VColor.contentTertiary)
                }
            }
        }
    }

    private static func buttonStyle(for action: String) -> VButton.Style {
        if action == "deny" || action == "reject" { return .danger }
        if action.hasPrefix("approve") || action == "allow" { return .primary }
        return .outlined
    }
}
