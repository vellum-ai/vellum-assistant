import SwiftUI

public struct ToolConfirmationBubble: View {
    public let confirmation: ToolConfirmationData
    /// When true, show the humanDescription above buttons (used when no assistant text precedes this).
    public let showDescription: Bool
    public let onAllow: () -> Void
    public let onDeny: () -> Void
    public let onAddTrustRule: (String, String, String, String) -> Bool

    @State private var showDetails = false

    public init(confirmation: ToolConfirmationData, showDescription: Bool = false, onAllow: @escaping () -> Void, onDeny: @escaping () -> Void, onAddTrustRule: @escaping (String, String, String, String) -> Bool) {
        self.confirmation = confirmation
        self.showDescription = showDescription
        self.onAllow = onAllow
        self.onDeny = onDeny
        self.onAddTrustRule = onAddTrustRule
    }

    private var hasRuleOptions: Bool {
        !confirmation.allowlistOptions.isEmpty && !confirmation.scopeOptions.isEmpty
    }

    private var isDecided: Bool {
        confirmation.state != .pending
    }

    /// The raw command/path preview for the details disclosure.
    private var detailsPreview: String? {
        let preview = confirmation.commandPreview
        return preview.isEmpty ? nil : preview
    }

    public var body: some View {
        if confirmation.isSystemPermissionRequest {
            if isDecided {
                systemPermissionCollapsed
            } else {
                systemPermissionCard
            }
        } else {
            if isDecided {
                collapsedContent
            } else {
                pendingContent
            }
        }
    }

    // MARK: - System Permission Card (TCC)

    @ViewBuilder
    private var systemPermissionCard: some View {
        VStack(alignment: .leading, spacing: VSpacing.md) {
            HStack(spacing: VSpacing.sm) {
                Image(systemName: "lock.shield.fill")
                    .font(.system(size: 16))
                    .foregroundColor(VColor.accent)

                Text(confirmation.permissionFriendlyName)
                    .font(VFont.bodyBold)
                    .foregroundColor(VColor.textPrimary)
            }

            Text(confirmation.humanDescription)
                .font(VFont.body)
                .foregroundColor(VColor.textSecondary)

            HStack(spacing: VSpacing.sm) {
                VButton(label: "Open System Settings", style: .primary) {
                    #if os(macOS)
                    if let url = confirmation.settingsURL {
                        NSWorkspace.shared.open(url)
                    }
                    #endif
                }

                VButton(label: "I\u{2019}ve granted it", style: .ghost) {
                    onAllow()
                }

                VButton(label: "Skip", style: .ghost) {
                    onDeny()
                }
            }
        }
        .padding(VSpacing.lg)
        .background(
            RoundedRectangle(cornerRadius: VRadius.lg)
                .fill(VColor.surface)
        )
        .overlay(
            RoundedRectangle(cornerRadius: VRadius.lg)
                .stroke(VColor.surfaceBorder, lineWidth: 1)
        )
    }

    @ViewBuilder
    private var systemPermissionCollapsed: some View {
        HStack(spacing: VSpacing.sm) {
            Group {
                switch confirmation.state {
                case .approved:
                    Image(systemName: "checkmark.circle.fill")
                        .foregroundColor(VColor.success)
                case .denied:
                    Image(systemName: "xmark.circle.fill")
                        .foregroundColor(VColor.error)
                case .timedOut:
                    Image(systemName: "clock.fill")
                        .foregroundColor(VColor.textMuted)
                default:
                    EmptyView()
                }
            }
            .font(.system(size: 12))

            Text(confirmation.state == .approved
                 ? "\(confirmation.permissionFriendlyName) granted"
                 : confirmation.state == .denied
                 ? "\(confirmation.permissionFriendlyName) skipped"
                 : "Timed out")
                .font(VFont.caption)
                .foregroundColor(VColor.textSecondary)

            Spacer()
        }
    }

    // MARK: - Tool Permission (pending)

    @ViewBuilder
    private var pendingContent: some View {
        if showDescription {
            Text(confirmation.humanDescription)
                .font(VFont.body)
                .foregroundColor(VColor.textPrimary)
                .frame(maxWidth: 520, alignment: .leading)
        }

        HStack(spacing: VSpacing.sm) {
            VButton(label: "Don\u{2019}t Allow", style: .ghost) {
                onDeny()
            }

            VButton(label: "Allow", style: .primary) {
                onAllow()
            }

            if hasRuleOptions {
                VButton(label: "Always Allow", style: .ghost) {
                    let pattern = confirmation.allowlistOptions.first?.pattern ?? ""
                    let scope = confirmation.scopeOptions.first?.scope ?? ""
                    if !pattern.isEmpty && !scope.isEmpty {
                        _ = onAddTrustRule(confirmation.toolName, pattern, scope, "allow")
                    }
                    onAllow()
                }
            }

            Spacer()

            if detailsPreview != nil {
                Button {
                    withAnimation(VAnimation.fast) {
                        showDetails.toggle()
                    }
                } label: {
                    HStack(spacing: 3) {
                        Text("Details")
                            .font(.system(size: 10))
                            .foregroundColor(VColor.textMuted)
                        Image(systemName: showDetails ? "chevron.up" : "chevron.down")
                            .font(.system(size: 8, weight: .semibold))
                            .foregroundColor(VColor.textMuted)
                    }
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityLabel(showDetails ? "Hide details" : "Show details")
            }
        }

        if showDetails, let preview = detailsPreview {
            Text(preview)
                .font(VFont.mono)
                .foregroundColor(VColor.textSecondary)
                .padding(VSpacing.sm)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(
                    RoundedRectangle(cornerRadius: VRadius.sm)
                        .fill(VColor.backgroundSubtle)
                )
                .textSelection(.enabled)
                .transition(.opacity.combined(with: .move(edge: .top)))
        }
    }

    // MARK: - Tool Permission (decided)

    @ViewBuilder
    private var collapsedContent: some View {
        HStack(spacing: VSpacing.sm) {
            Group {
                switch confirmation.state {
                case .approved:
                    Image(systemName: "checkmark.circle.fill")
                        .foregroundColor(VColor.success)
                case .denied:
                    Image(systemName: "xmark.circle.fill")
                        .foregroundColor(VColor.error)
                case .timedOut:
                    Image(systemName: "clock.fill")
                        .foregroundColor(VColor.textMuted)
                default:
                    EmptyView()
                }
            }
            .font(.system(size: 12))

            Text(confirmation.state == .approved ? "Permission granted" :
                 confirmation.state == .denied ? "Permission denied" : "Timed out")
                .font(VFont.caption)
                .foregroundColor(VColor.textSecondary)

            Spacer()
        }
    }
}

#if DEBUG
#Preview("ToolConfirmationBubble") {
    VStack(spacing: VSpacing.lg) {
        // System permission request (pending)
        ToolConfirmationBubble(
            confirmation: ToolConfirmationData(
                requestId: "test-perm",
                toolName: "request_system_permission",
                input: [
                    "permission_type": AnyCodable("full_disk_access"),
                    "reason": AnyCodable("I need Full Disk Access to read your Documents folder.")
                ],
                riskLevel: "high"
            ),
            onAllow: {},
            onDeny: {},
            onAddTrustRule: { _, _, _, _ in true }
        )
        // System permission (granted)
        ToolConfirmationBubble(
            confirmation: ToolConfirmationData(
                requestId: "test-perm-done",
                toolName: "request_system_permission",
                input: [
                    "permission_type": AnyCodable("full_disk_access"),
                    "reason": AnyCodable("I need Full Disk Access to read your Documents folder.")
                ],
                riskLevel: "high",
                state: .approved
            ),
            onAllow: {},
            onDeny: {},
            onAddTrustRule: { _, _, _, _ in true }
        )
        // Tool confirmation (pending)
        ToolConfirmationBubble(
            confirmation: ToolConfirmationData(
                requestId: "test-1",
                toolName: "host_bash",
                input: ["command": AnyCodable("ls -lt ~/Downloads/ | head -50")],
                riskLevel: "low",
                executionTarget: "host"
            ),
            onAllow: {},
            onDeny: {},
            onAddTrustRule: { _, _, _, _ in true }
        )
        // Tool confirmation (approved)
        ToolConfirmationBubble(
            confirmation: ToolConfirmationData(
                requestId: "test-2",
                toolName: "host_bash",
                input: ["command": AnyCodable("npm install")],
                riskLevel: "medium",
                allowlistOptions: [
                    ConfirmationRequestMessage.ConfirmationAllowlistOption(label: "npm install", description: "This exact command", pattern: "npm install"),
                ],
                scopeOptions: [
                    ConfirmationRequestMessage.ConfirmationScopeOption(label: "Everywhere", scope: "everywhere"),
                ],
                state: .approved
            ),
            onAllow: {},
            onDeny: {},
            onAddTrustRule: { _, _, _, _ in true }
        )
    }
    .padding(VSpacing.xl)
    .background(VColor.background)
}
#endif
