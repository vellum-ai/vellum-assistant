import SwiftUI

/// Renders a guardian decision prompt with actionable buttons in the chat UI.
/// Supports multiple request kinds: `tool_approval`, `pending_question`, and
/// `access_request`, each with a distinct header and accent color.
/// Uses shared `ApprovalActionButton`, `GuardianApprovalActionRow`, and
/// `ApprovalStatusRow` primitives from the unified approval UI layer.
public struct GuardianDecisionBubble: View {
    public let decision: GuardianDecisionData
    public let onAction: (String, String) -> Void

    public init(decision: GuardianDecisionData, onAction: @escaping (String, String) -> Void) {
        self.decision = decision
        self.onAction = onAction
    }

    private var isPending: Bool {
        if case .pending = decision.state { return true }
        return false
    }

    // MARK: - Kind-aware header configuration

    /// Header icon, title, and accent color derived from the canonical request kind.
    private var headerConfig: (icon: VIcon, title: String, accent: Color) {
        switch decision.kind {
        case "pending_question":
            return (.circleAlert, "Question Pending", VColor.primaryBase)
        case "access_request":
            return (.circleUser, "Access Request", VColor.systemNegativeHover)
        case "tool_approval":
            return (.shieldAlert, "Tool Approval Required", VColor.systemNegativeHover)
        default:
            return (.shieldAlert, "Guardian Approval Required", VColor.systemNegativeHover)
        }
    }

    public var body: some View {
        if isPending {
            pendingContent
        } else {
            collapsedContent
        }
    }

    // MARK: - Pending (actionable)

    @ViewBuilder
    private var pendingContent: some View {
        let config = headerConfig

        VStack(alignment: .leading, spacing: VSpacing.sm) {
            // Kind-aware header
            HStack(spacing: VSpacing.sm) {
                VIconView(config.icon, size: 14)
                    .foregroundColor(config.accent)

                Text(config.title)
                    .font(VFont.captionMedium)
                    .foregroundColor(VColor.contentSecondary)
            }

            // Question text (primary interaction prompt)
            Text(decision.questionText)
                .font(VFont.bodyBold)
                .foregroundColor(VColor.contentDefault)
                .fixedSize(horizontal: false, vertical: true)

            // Action buttons (primary interaction)
            GuardianApprovalActionRow(
                actions: decision.actions,
                isSubmitting: decision.isSubmitting
            ) { action in
                onAction(decision.requestId, action)
            }

            // Secondary metadata: tool name and request code reference
            if hasSecondaryMetadata {
                Divider()

                VStack(alignment: .leading, spacing: VSpacing.xxs) {
                    if let toolName = decision.toolName, !toolName.isEmpty {
                        HStack(spacing: VSpacing.xs) {
                            VIconView(.wrench, size: 10)
                                .foregroundColor(VColor.contentTertiary)
                            Text(toolName)
                                .font(VFont.monoSmall)
                                .foregroundColor(VColor.contentSecondary)
                        }
                    }

                    if !decision.requestCode.isEmpty {
                        HStack(spacing: VSpacing.xs) {
                            Text("Ref:")
                                .font(VFont.caption)
                                .foregroundColor(VColor.contentTertiary)
                            Text(decision.requestCode)
                                .font(VFont.monoSmall)
                                .foregroundColor(VColor.contentTertiary)
                        }
                    }
                }
            }
        }
        .padding(VSpacing.md)
        .background(
            RoundedRectangle(cornerRadius: VRadius.md)
                .fill(VColor.surfaceBase)
                .overlay(
                    RoundedRectangle(cornerRadius: VRadius.md)
                        .stroke(config.accent.opacity(0.3), lineWidth: 1)
                )
        )
    }

    private var hasSecondaryMetadata: Bool {
        let hasToolName = decision.toolName != nil && !(decision.toolName?.isEmpty ?? true)
        let hasRequestCode = !decision.requestCode.isEmpty
        return hasToolName || hasRequestCode
    }

    // MARK: - Collapsed (resolved or stale)

    @ViewBuilder
    private var collapsedContent: some View {
        ApprovalStatusRow(
            outcome: resolvedOutcome,
            label: resolvedLabel
        )
    }

    private var resolvedOutcome: ApprovalOutcome {
        switch decision.state {
        case .resolved(let action):
            if action == "deny" || action == "reject" {
                return .denied
            }
            return .approved
        case .stale:
            return .stale
        case .pending:
            return .approved
        }
    }

    private var resolvedLabel: String {
        switch decision.state {
        case .resolved(let action):
            let actionLabel = decision.actions.first(where: { $0.action == action })?.label ?? action
            return "Guardian: \(actionLabel)"
        case .stale(let reason):
            if let reason, !reason.isEmpty {
                return "Guardian: \(reason)"
            }
            return "Guardian: already resolved"
        case .pending:
            return ""
        }
    }
}

#if DEBUG
#Preview("GuardianDecisionBubble") {
    VStack(spacing: VSpacing.lg) {
        // Tool approval (default kind)
        GuardianDecisionBubble(
            decision: GuardianDecisionData(
                requestId: "req-1",
                requestCode: "GRD-A1B2",
                questionText: "Allow running a shell command on the host?",
                toolName: "host_bash",
                actions: [
                    GuardianActionOption(action: "approve", label: "Approve"),
                    GuardianActionOption(action: "deny", label: "Deny"),
                ],
                conversationId: "conv-1",
                kind: "tool_approval"
            ),
            onAction: { _, _ in }
        )

        // Access request kind
        GuardianDecisionBubble(
            decision: GuardianDecisionData(
                requestId: "req-6",
                requestCode: "GRD-K1L2",
                questionText: "User john@example.com is requesting access to the assistant.",
                toolName: nil,
                actions: [
                    GuardianActionOption(action: "approve", label: "Grant Access"),
                    GuardianActionOption(action: "deny", label: "Deny"),
                ],
                conversationId: "conv-1",
                kind: "access_request"
            ),
            onAction: { _, _ in }
        )

        // Pending question kind
        GuardianDecisionBubble(
            decision: GuardianDecisionData(
                requestId: "req-5",
                requestCode: "GRD-I9J0",
                questionText: "What is the preferred deployment target?",
                toolName: nil,
                actions: [
                    GuardianActionOption(action: "approve_once", label: "Approve"),
                    GuardianActionOption(action: "reject", label: "Reject"),
                ],
                conversationId: "conv-1",
                kind: "pending_question"
            ),
            onAction: { _, _ in }
        )

        // Resolved (approved)
        GuardianDecisionBubble(
            decision: GuardianDecisionData(
                requestId: "req-2",
                requestCode: "GRD-C3D4",
                questionText: "Allow writing to config file?",
                toolName: "file_write",
                actions: [],
                conversationId: "conv-1",
                state: .resolved(action: "approve")
            ),
            onAction: { _, _ in }
        )

        // Stale (no reason)
        GuardianDecisionBubble(
            decision: GuardianDecisionData(
                requestId: "req-3",
                requestCode: "GRD-E5F6",
                questionText: "Allow web fetch?",
                toolName: "web_fetch",
                actions: [],
                conversationId: "conv-1",
                state: .stale()
            ),
            onAction: { _, _ in }
        )

        // Stale (with reason)
        GuardianDecisionBubble(
            decision: GuardianDecisionData(
                requestId: "req-4",
                requestCode: "GRD-G7H8",
                questionText: "Allow file read?",
                toolName: "file_read",
                actions: [],
                conversationId: "conv-1",
                state: .stale(reason: "expired")
            ),
            onAction: { _, _ in }
        )
    }
    .padding(VSpacing.xl)
    .background(VColor.surfaceOverlay)
}
#endif
