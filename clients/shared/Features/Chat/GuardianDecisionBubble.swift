import SwiftUI

/// Renders a guardian decision prompt with actionable buttons in the chat UI.
/// Follows the same card styling pattern as `ToolConfirmationBubble`.
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

    /// The canonical request kind (e.g. "tool_approval", "pending_question").
    /// Determines header text and available action rendering.
    private var kind: String? {
        decision.kind
    }

    /// Whether this prompt is for a pending question (voice-originated).
    private var isPendingQuestion: Bool {
        kind == "pending_question"
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
        VStack(alignment: .leading, spacing: VSpacing.sm) {
            // Header — adapts to the canonical request kind
            HStack(spacing: VSpacing.sm) {
                Image(systemName: isPendingQuestion ? "questionmark.circle.fill" : "shield.lefthalf.filled")
                    .font(.system(size: 14))
                    .foregroundColor(isPendingQuestion ? VColor.accent : VColor.warning)

                Text(isPendingQuestion ? "Question Pending" : "Guardian Approval Required")
                    .font(VFont.captionMedium)
                    .foregroundColor(VColor.textSecondary)
            }

            // Question text
            Text(decision.questionText)
                .font(VFont.bodyBold)
                .foregroundColor(VColor.textPrimary)
                .fixedSize(horizontal: false, vertical: true)

            // Tool name
            if let toolName = decision.toolName, !toolName.isEmpty {
                HStack(spacing: VSpacing.xs) {
                    Image(systemName: "wrench")
                        .font(.system(size: 10))
                        .foregroundColor(VColor.textMuted)
                    Text(toolName)
                        .font(VFont.monoSmall)
                        .foregroundColor(VColor.textSecondary)
                }
            }

            // Request code reference
            if !decision.requestCode.isEmpty {
                HStack(spacing: VSpacing.xs) {
                    Text("Ref:")
                        .font(VFont.caption)
                        .foregroundColor(VColor.textMuted)
                    Text(decision.requestCode)
                        .font(VFont.monoSmall)
                        .foregroundColor(VColor.textMuted)
                }
            }

            // Action buttons
            HStack(spacing: VSpacing.xs) {
                ForEach(decision.actions, id: \.action) { actionOption in
                    actionButton(actionOption)
                }
                Spacer()
            }
            .opacity(decision.isSubmitting ? 0.5 : 1.0)
            .allowsHitTesting(!decision.isSubmitting)

            if decision.isSubmitting {
                HStack(spacing: VSpacing.xs) {
                    ProgressView()
                        .controlSize(.small)
                    Text("Submitting...")
                        .font(VFont.caption)
                        .foregroundColor(VColor.textMuted)
                }
            }
        }
        .padding(VSpacing.md)
        .background(
            RoundedRectangle(cornerRadius: VRadius.md)
                .fill(VColor.surface)
                .overlay(
                    RoundedRectangle(cornerRadius: VRadius.md)
                        .stroke(
                            (isPendingQuestion ? VColor.accent : VColor.warning).opacity(0.3),
                            lineWidth: 1
                        )
                )
        )
    }

    // MARK: - Collapsed (resolved or stale)

    @ViewBuilder
    private var collapsedContent: some View {
        HStack(spacing: VSpacing.sm) {
            Group {
                switch decision.state {
                case .resolved(let action):
                    if action == "deny" || action == "reject" {
                        Image(systemName: "xmark.circle.fill")
                            .foregroundColor(VColor.error)
                    } else {
                        Image(systemName: "checkmark.circle.fill")
                            .foregroundColor(VColor.success)
                    }
                case .stale(_):
                    Image(systemName: "clock.fill")
                        .foregroundColor(VColor.textMuted)
                case .pending:
                    EmptyView()
                }
            }
            .font(.system(size: 12))

            Text(resolvedLabel)
                .font(VFont.caption)
                .foregroundColor(VColor.textSecondary)

            Spacer()
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

    // MARK: - Action Button

    @ViewBuilder
    private func actionButton(_ actionOption: GuardianActionOption) -> some View {
        let isPrimary = actionOption.action.hasPrefix("approve") || actionOption.action == "allow"
        let isDanger = actionOption.action == "deny" || actionOption.action == "reject"

        Button {
            onAction(decision.requestId, actionOption.action)
        } label: {
            Text(actionOption.label)
                .font(VFont.caption)
                .foregroundColor(isPrimary ? .white : isDanger ? VColor.error : VColor.textSecondary)
                .padding(.horizontal, VSpacing.sm)
                .padding(.vertical, VSpacing.xxs + 1)
                .background(isPrimary ? VColor.buttonPrimary : Color.clear)
                .clipShape(RoundedRectangle(cornerRadius: VRadius.sm))
                .overlay(
                    RoundedRectangle(cornerRadius: VRadius.sm)
                        .stroke(isPrimary ? Color.clear : isDanger ? VColor.error.opacity(0.5) : VColor.surfaceBorder, lineWidth: 1)
                )
        }
        .buttonStyle(.plain)
        .accessibilityLabel(actionOption.label)
    }
}

#if DEBUG
#Preview("GuardianDecisionBubble") {
    VStack(spacing: VSpacing.lg) {
        // Pending with actions
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
                conversationId: "conv-1"
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
    }
    .padding(VSpacing.xl)
    .background(VColor.background)
}
#endif
