import SwiftUI
#if os(macOS)
import AppKit
#endif

public struct ToolConfirmationBubble: View {
    public let confirmation: ToolConfirmationData
    public let onAllow: () -> Void
    public let onDeny: () -> Void
    public let onAlwaysAllow: (String, String, String, String) -> Void
    /// Called when a temporary approval option is selected: (requestId, decision).
    public let onTemporaryAllow: ((String, String) -> Void)?
    /// When `true` this bubble owns the keyboard monitor and shows selection
    /// highlights. When `false` the monitor is removed and keyboard-only state
    /// is cleared so a lower stacked bubble doesn't steal input.
    public let isKeyboardActive: Bool
    /// Called when the user taps the post-decision "Create a rule" nudge.
    /// The caller is responsible for presenting the rule editor.
    public let onCreateRule: (() -> Void)?
    /// Called when the user taps "Allow & Create Rule" in the v3 prompt.
    /// The parent should allow the tool, call the suggest API, and open the rule editor.
    public let onAllowAndSuggestRule: (() -> Void)?

    public init(
        confirmation: ToolConfirmationData,
        isKeyboardActive: Bool = true,
        onAllow: @escaping () -> Void,
        onDeny: @escaping () -> Void,
        onAlwaysAllow: @escaping (String, String, String, String) -> Void,
        onTemporaryAllow: ((String, String) -> Void)? = nil,
        onCreateRule: (() -> Void)? = nil,
        onAllowAndSuggestRule: (() -> Void)? = nil
    ) {
        self.confirmation = confirmation
        self.isKeyboardActive = isKeyboardActive
        self.onAllow = onAllow
        self.onDeny = onDeny
        self.onAlwaysAllow = onAlwaysAllow
        self.onTemporaryAllow = onTemporaryAllow
        self.onCreateRule = onCreateRule
        self.onAllowAndSuggestRule = onAllowAndSuggestRule
    }

    private var isDecided: Bool {
        confirmation.state != .pending
    }

    /// The decision value to send when "Always Allow" is clicked.
    private var alwaysAllowDecision: String {
        "always_allow"
    }

    /// Label shown in the collapsed state after a decision is made.
    private var collapsedLabel: String {
        if confirmation.isConversationHostAccessPrompt {
            switch confirmation.state {
            case .approved:
                return "Computer access enabled for this conversation"
            case .denied:
                return "Computer access not enabled for this conversation"
            case .timedOut:
                return "Timed out"
            case .pending:
                return ""
            }
        }

        switch confirmation.state {
        case .approved:
            switch confirmation.approvedDecision {
            case "allow_10m":
                return "\(confirmation.toolCategory) allowed for 10 minutes"
            case "allow_conversation":
                return "\(confirmation.toolCategory) allowed for this conversation"
            default:
                return "\(confirmation.toolCategory) allowed"
            }
        case .denied:
            return "\(confirmation.toolCategory) denied"
        case .timedOut:
            return "Timed out"
        case .pending:
            return ""
        }
    }

    /// Whether to show the post-decision "Create a rule" nudge.
    private var showPostDecisionNudge: Bool {
        false
    }

    public var body: some View {
        // System permissions still use the legacy system permission card
        if confirmation.isSystemPermissionRequest {
            if isDecided {
                systemPermissionCollapsed
            } else {
                systemPermissionCard
            }
        } else if isDecided {
            // Decided confirmations use the collapsed view
            collapsedContent
        } else {
            // Pending prompts use the v3 view
            PermissionPromptView(
                confirmation: confirmation,
                isKeyboardActive: isKeyboardActive,
                onAllow: onAllow,
                onDeny: onDeny,
                onAlwaysAllow: onAlwaysAllow,
                onAllowAndSuggestRule: onAllowAndSuggestRule
            )
        }
    }

    // MARK: - System Permission Card (TCC)

    @ViewBuilder
    private var systemPermissionCard: some View {
        VStack(alignment: .leading, spacing: VSpacing.md) {
            HStack(spacing: VSpacing.sm) {
                VIconView(.shield, size: 16)
                    .foregroundStyle(VColor.primaryBase)

                Text(confirmation.permissionFriendlyName)
                    .font(VFont.bodyMediumEmphasised)
                    .foregroundStyle(VColor.contentDefault)
            }

            Text(confirmation.humanDescription)
                .font(VFont.bodyMediumLighter)
                .foregroundStyle(VColor.contentSecondary)

            HStack(spacing: VSpacing.sm) {
                VButton(label: "Open System Settings", style: .primary) {
                    #if os(macOS)
                    if let url = confirmation.settingsURL {
                        NSWorkspace.shared.open(url)
                    }
                    #endif
                }

                VButton(label: "I\u{2019}ve granted it", style: .outlined) {
                    onAllow()
                }

                VButton(label: "Skip", style: .outlined) {
                    onDeny()
                }
            }
        }
        .padding(VSpacing.lg)
        .background(
            RoundedRectangle(cornerRadius: VRadius.lg)
                .fill(VColor.surfaceOverlay)
        )
        .overlay(
            RoundedRectangle(cornerRadius: VRadius.lg)
                .stroke(VColor.borderBase, lineWidth: 0.5)
        )
        .textSelection(.disabled)
    }

    @ViewBuilder
    private var systemPermissionCollapsed: some View {
        ApprovalStatusRow(
            outcome: collapsedOutcome,
            label: systemPermissionCollapsedLabel
        )
    }

    private var systemPermissionCollapsedLabel: String {
        switch confirmation.state {
        case .approved:  return "\(confirmation.permissionFriendlyName) granted"
        case .denied:    return "\(confirmation.permissionFriendlyName) skipped"
        case .timedOut:  return "Timed out"
        case .pending:   return ""
        }
    }

    // MARK: - Tool Permission (decided)

    @ViewBuilder
    private var collapsedContent: some View {
        VStack(alignment: .leading, spacing: VSpacing.xs) {
            ApprovalStatusRow(
                outcome: collapsedOutcome,
                label: collapsedLabel
            )

            // Post-decision nudge: offer to create a rule for unknown-risk actions.
            if showPostDecisionNudge {
                postDecisionNudge
            }
        }
    }

    /// Post-decision link prompting the user to create a trust rule for actions
    /// that the classifier could not confidently assess (unknown risk only).
    @ViewBuilder
    private var postDecisionNudge: some View {
        Button {
            onCreateRule?()
        } label: {
            HStack(spacing: VSpacing.xxs) {
                VIconView(.plus, size: 12)
                    .foregroundStyle(VColor.primaryBase)
                Text("Create a rule for this")
                    .font(VFont.labelDefault)
                    .foregroundStyle(VColor.primaryBase)
            }
        }
        .buttonStyle(.plain)
        .accessibilityLabel("Create a rule for this action")
    }

    private var collapsedOutcome: ApprovalOutcome {
        switch confirmation.state {
        case .approved:  return .approved
        case .denied:    return .denied
        case .timedOut:  return .timedOut
        case .pending:   return .approved
        }
    }

}
