import SwiftUI

/// Renders a guardian decision prompt with actionable buttons in the chat UI.
/// Supports multiple request kinds: `tool_approval`, `pending_question`, and
/// `access_request`, each with a distinct header and accent color.
/// Uses `GuardianApprovalActionRow` (backed by `VButton`) and
/// `ApprovalStatusRow` from the unified approval UI layer.
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
            return (.circleUser, "Access Request", VColor.systemMidStrong)
        case "tool_approval":
            return (.shieldAlert, "Tool Approval Required", VColor.systemMidStrong)
        default:
            return (.shieldAlert, "Guardian Approval Required", VColor.systemMidStrong)
        }
    }

    /// Maps `decision.riskLevel` to a semantic color for badges and accents.
    private var riskColor: Color {
        switch decision.riskLevel?.lowercased() {
        case "high":
            return VColor.systemNegativeStrong
        case "medium":
            return VColor.systemMidStrong
        default:
            return VColor.systemPositiveStrong
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

    /// The accent color for the card border and header icon. Uses `riskColor`
    /// when a risk level is present on a tool_approval; otherwise falls back to
    /// the kind-derived accent from `headerConfig`.
    private var cardAccent: Color {
        if decision.kind == "tool_approval", decision.riskLevel != nil {
            return riskColor
        }
        return headerConfig.accent
    }

    @ViewBuilder
    private var pendingContent: some View {
        let config = headerConfig

        VStack(alignment: .leading, spacing: VSpacing.sm) {
            // Kind-aware header
            HStack(spacing: VSpacing.sm) {
                VIconView(config.icon, size: 14)
                    .foregroundStyle(cardAccent)

                Text(config.title)
                    .font(VFont.labelDefault)
                    .foregroundStyle(VColor.contentSecondary)
            }

            // Badge row: risk level + execution target
            if decision.riskLevel != nil || decision.executionTarget != nil {
                HStack(spacing: VSpacing.xs) {
                    if let risk = decision.riskLevel {
                        Text(risk.uppercased())
                            .font(VFont.labelDefault)
                            .foregroundStyle(VColor.auxWhite)
                            .padding(.horizontal, VSpacing.sm)
                            .padding(.vertical, VSpacing.xxs)
                            .background(
                                RoundedRectangle(cornerRadius: VRadius.sm)
                                    .fill(riskColor)
                            )
                    }

                    if let target = decision.executionTarget {
                        Text(target.lowercased() == "host" ? "Host" : "Sandbox")
                            .font(VFont.labelDefault)
                            .foregroundStyle(VColor.contentSecondary)
                            .padding(.horizontal, VSpacing.sm)
                            .padding(.vertical, VSpacing.xxs)
                            .overlay(
                                RoundedRectangle(cornerRadius: VRadius.sm)
                                    .stroke(VColor.contentTertiary.opacity(0.5), lineWidth: 1)
                            )
                    }
                }
            }

            // Activity text (primary description) — falls back to questionText
            if let activityText = decision.activityText, !activityText.isEmpty {
                Text(activityText)
                    .font(VFont.bodyMediumEmphasised)
                    .foregroundStyle(VColor.contentDefault)
                    .fixedSize(horizontal: false, vertical: true)
            } else {
                Text(decision.questionText)
                    .font(VFont.bodyMediumEmphasised)
                    .foregroundStyle(VColor.contentDefault)
                    .fixedSize(horizontal: false, vertical: true)
            }

            // Command preview code block
            if let preview = decision.commandPreview, !preview.isEmpty {
                let previewLineCount = preview.utf8.reduce(1) { $0 + ($1 == 0x0A ? 1 : 0) }
                let previewIsLong = previewLineCount > 7 || (previewLineCount == 1 && preview.utf8.count > 50_000)
                Group {
                    if previewIsLong {
                        ScrollView {
                            HStack(spacing: 0) {
                                Text(preview)
                                    .font(.system(size: 12, design: .monospaced))
                                    .foregroundStyle(VColor.contentSecondary)
                                    .textSelection(.enabled)
                                Spacer(minLength: 0)
                            }
                        }
                        .frame(height: 120)
                    } else {
                        HStack(spacing: 0) {
                            Text(preview)
                                .font(.system(size: 12, design: .monospaced))
                                .foregroundStyle(VColor.contentSecondary)
                                .textSelection(.enabled)
                            Spacer(minLength: 0)
                        }
                    }
                }
                .padding(VSpacing.sm)
                .background(
                    RoundedRectangle(cornerRadius: VRadius.sm)
                        .fill(VColor.surfaceOverlay)
                )
            }

            // Action buttons (primary interaction)
            GuardianApprovalActionRow(
                actions: decision.actions,
                isSubmitting: decision.isSubmitting
            ) { action in
                onAction(decision.requestId, action)
            }

            // Scope hint for temporal approval options
            if decision.actions.contains(where: { $0.action == "approve_10m" || $0.action == "approve_conversation" }) {
                Text("Temporal options apply to all pending tool requests")
                    .font(VFont.bodySmallDefault)
                    .foregroundStyle(VColor.contentTertiary)
            }

            // Compact metadata footer: "bash · 8EE295"
            if hasSecondaryMetadata {
                metadataFooter
            }
        }
        .padding(VSpacing.md)
        .background(
            RoundedRectangle(cornerRadius: VRadius.md)
                .fill(VColor.surfaceOverlay)
                .overlay(
                    RoundedRectangle(cornerRadius: VRadius.md)
                        .stroke(cardAccent.opacity(0.3), lineWidth: 1)
                )
        )
        .textSelection(.disabled)
    }

    /// Compact metadata footer showing tool name and request code on a single line.
    @ViewBuilder
    private var metadataFooter: some View {
        let parts: [String] = {
            var result: [String] = []
            if let toolName = decision.toolName, !toolName.isEmpty {
                result.append(toolName)
            }
            if !decision.requestCode.isEmpty {
                result.append(decision.requestCode)
            }
            return result
        }()

        if !parts.isEmpty {
            Text(parts.joined(separator: " \u{00B7} "))
                .font(VFont.bodySmallDefault)
                .foregroundStyle(VColor.contentTertiary)
        }
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
