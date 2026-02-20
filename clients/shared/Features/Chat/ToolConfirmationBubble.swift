import SwiftUI
#if os(macOS)
import AppKit
#endif

public struct ToolConfirmationBubble: View {
    public let confirmation: ToolConfirmationData
    public let onAllow: () -> Void
    public let onDeny: () -> Void
    public let onAlwaysAllow: (String, String, String, String) -> Void

    @State private var showDiff = false
    @State private var showAlwaysAllowMenu = false
    @State private var showTechnicalDetails = true
    /// Tracks a selected pattern while waiting for the user to pick a scope.
    @State private var pendingPattern: String?
    @State private var showScopePickerMenu = false
    @State private var keyboardModel: ToolConfirmationKeyboardModel?
    #if os(macOS)
    @State private var keyMonitor: Any?
    #endif

    public init(confirmation: ToolConfirmationData, onAllow: @escaping () -> Void, onDeny: @escaping () -> Void, onAlwaysAllow: @escaping (String, String, String, String) -> Void) {
        self.confirmation = confirmation
        self.onAllow = onAllow
        self.onDeny = onDeny
        self.onAlwaysAllow = onAlwaysAllow
    }

    private var hasRuleOptions: Bool {
        !confirmation.allowlistOptions.isEmpty && !confirmation.scopeOptions.isEmpty
    }

    private var needsScopeChoice: Bool {
        confirmation.scopeOptions.count > 1
    }

    private var isDecided: Bool {
        confirmation.state != .pending
    }

    /// The decision value to send when "Always Allow" is clicked.
    /// High-risk prompts use `always_allow_high_risk` so the daemon persists
    /// a rule with `allowHighRisk: true`.
    private var alwaysAllowDecision: String {
        confirmation.riskLevel.lowercased() == "high" ? "always_allow_high_risk" : "always_allow"
    }

    /// The raw command/path preview for the inline display.
    private var inlinePreviewText: String? {
        let preview = confirmation.commandPreview
        return preview.isEmpty ? nil : preview
    }

    /// Color for the risk level badge.
    private var riskColor: Color {
        switch confirmation.riskLevel.lowercased() {
        case "low":    return VColor.textMuted
        case "medium": return VColor.warning
        case "high":   return VColor.error
        default:       return VColor.textMuted
        }
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
        VStack(alignment: .leading, spacing: VSpacing.sm) {
            // Bold non-technical question
            Text(confirmation.humanDescription)
                .font(VFont.bodyBold)
                .foregroundColor(VColor.textPrimary)

            // Action buttons at top
            buttonRow

            Divider()

            // More Details accordion (expanded by default)
            VStack(alignment: .leading, spacing: 0) {
                Button {
                    withAnimation(VAnimation.fast) {
                        showTechnicalDetails.toggle()
                    }
                } label: {
                    HStack(spacing: VSpacing.xs) {
                        Image(systemName: "chevron.right")
                            .font(.system(size: 9, weight: .semibold))
                            .foregroundColor(VColor.textMuted)
                            .rotationEffect(.degrees(showTechnicalDetails ? 90 : 0))
                        Text(showTechnicalDetails ? "Hide" : "More details")
                            .font(VFont.captionMedium)
                            .foregroundColor(VColor.textMuted)
                    }
                }
                .buttonStyle(.plain)

                if showTechnicalDetails {
                    VStack(alignment: .leading, spacing: VSpacing.xs) {
                        if let preview = inlinePreviewText {
                            inlinePreview(preview)
                        }
                        if confirmation.hasDiff {
                            diffDisclosure
                        }
                    }
                    .padding(.top, VSpacing.xs)
                    .transition(.opacity.combined(with: .move(edge: .top)))
                }
            }
            .clipped()
        }
        .padding(VSpacing.md)
        .background(
            RoundedRectangle(cornerRadius: VRadius.md)
                .fill(VColor.surface)
                .overlay(
                    RoundedRectangle(cornerRadius: VRadius.md)
                        .stroke(VColor.surfaceBorder, lineWidth: 1)
                )
        )
    }

    // MARK: - Header Row

    @ViewBuilder
    private var headerRow: some View {
        HStack(spacing: VSpacing.sm) {
            Image(systemName: confirmation.toolCategoryIcon)
                .font(.system(size: 12))
                .foregroundColor(VColor.textSecondary)

            Text(confirmation.toolCategory)
                .font(VFont.captionMedium)
                .foregroundColor(VColor.textPrimary)

            VBadge(
                style: .label(confirmation.riskLevel.capitalized),
                color: riskColor
            )

            if let target = confirmation.normalizedExecutionTarget {
                Text(target)
                    .font(VFont.caption)
                    .foregroundColor(VColor.textMuted)
                    .padding(.horizontal, VSpacing.sm)
                    .padding(.vertical, VSpacing.xxs)
                    .background(
                        Capsule()
                            .fill(VColor.backgroundSubtle)
                    )
            }

            Spacer()
        }
    }

    // MARK: - Inline Preview

    @ViewBuilder
    private func inlinePreview(_ preview: String) -> some View {
        Text(preview)
            .font(VFont.monoSmall)
            .foregroundColor(VColor.textSecondary)
            .fixedSize(horizontal: false, vertical: true)
            .textSelection(.enabled)
            .padding(VSpacing.sm)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(
                RoundedRectangle(cornerRadius: VRadius.sm)
                    .fill(VColor.backgroundSubtle)
            )
    }

    // MARK: - Description Text

    @ViewBuilder
    private var descriptionText: some View {
        Text(confirmation.humanDescription)
            .font(VFont.caption)
            .foregroundColor(VColor.textMuted)
    }

    // MARK: - Diff Disclosure

    @ViewBuilder
    private var diffDisclosure: some View {
        VStack(alignment: .leading, spacing: VSpacing.xs) {
            Button {
                withAnimation(VAnimation.fast) {
                    showDiff.toggle()
                }
            } label: {
                HStack(spacing: 3) {
                    Text("View diff")
                        .font(.system(size: 10))
                        .foregroundColor(VColor.textMuted)
                    Image(systemName: showDiff ? "chevron.up" : "chevron.down")
                        .font(.system(size: 8, weight: .semibold))
                        .foregroundColor(VColor.textMuted)
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel(showDiff ? "Hide diff" : "View diff")

            if showDiff, let diffInfo = confirmation.diff {
                VStack(alignment: .leading, spacing: VSpacing.xs) {
                    Text(diffInfo.filePath)
                        .font(VFont.monoSmall)
                        .foregroundColor(VColor.textMuted)

                    Text(diffInfo.newContent)
                        .font(VFont.mono)
                        .foregroundColor(VColor.textSecondary)
                        .lineLimit(10)
                }
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
    }

    // MARK: - Button Row

    /// Build the ordered list of top-level actions based on current confirmation state.
    private var topLevelActions: [ToolConfirmationKeyboardModel.Action] {
        var actions: [ToolConfirmationKeyboardModel.Action] = [.allowOnce]
        if hasRuleOptions && confirmation.persistentDecisionsAllowed {
            actions.append(.alwaysAllow)
        }
        actions.append(.dontAllow)
        return actions
    }

    @ViewBuilder
    private var buttonRow: some View {
        let actions = topLevelActions
        HStack(spacing: VSpacing.xs) {
            confirmationButton(
                "Allow Once",
                isPrimary: true,
                isDanger: false,
                isKeyboardSelected: keyboardModel?.selectedAction == .allowOnce
            ) { onAllow() }
            if hasRuleOptions && confirmation.persistentDecisionsAllowed { alwaysAllowInlineButton }
            confirmationButton(
                "Don\u{2019}t Allow",
                isPrimary: false,
                isDanger: false,
                isKeyboardSelected: keyboardModel?.selectedAction == .dontAllow
            ) { onDeny() }
            Spacer()
        }
        .onAppear {
            #if os(macOS)
            installKeyMonitor(actions: actions)
            #else
            keyboardModel = ToolConfirmationKeyboardModel(actions: actions)
            #endif
        }
        .onDisappear {
            #if os(macOS)
            removeKeyMonitor()
            #endif
        }
    }

    // MARK: - Key Monitor (macOS)

    #if os(macOS)
    private func installKeyMonitor(actions: [ToolConfirmationKeyboardModel.Action]) {
        removeKeyMonitor()
        keyboardModel = ToolConfirmationKeyboardModel(actions: actions)
        keyMonitor = NSEvent.addLocalMonitorForEvents(matching: .keyDown) { event in
            // Pass through when a popover menu is open
            if showAlwaysAllowMenu || showScopePickerMenu {
                return event
            }
            switch event.keyCode {
            case 48 where event.modifierFlags.intersection(.deviceIndependentFlagsMask) == .shift:
                // Shift+Tab — move left
                keyboardModel?.moveLeft()
                return nil
            case 48:
                // Tab — move right
                keyboardModel?.moveRight()
                return nil
            case 36, 76:
                // Return / numpad Enter — activate
                if let action = keyboardModel?.selectedAction {
                    activateAction(action)
                }
                return nil
            case 53:
                // Escape — deny
                activateAction(.dontAllow)
                return nil
            default:
                return event
            }
        }
    }

    private func removeKeyMonitor() {
        if let monitor = keyMonitor {
            NSEvent.removeMonitor(monitor)
            keyMonitor = nil
        }
    }
    #endif

    /// Trigger the callback for a given top-level action.
    private func activateAction(_ action: ToolConfirmationKeyboardModel.Action) {
        switch action {
        case .allowOnce:
            onAllow()
        case .alwaysAllow:
            if confirmation.allowlistOptions.count > 1 {
                withAnimation(VAnimation.fast) {
                    pendingPattern = nil
                    showAlwaysAllowMenu.toggle()
                }
            } else {
                handleSingleOptionAlwaysAllow()
            }
        case .dontAllow:
            onDeny()
        }
    }

    /// Shared logic for the single-option Always Allow action, used by both the
    /// inline button click handler and keyboard Enter activation.
    private func handleSingleOptionAlwaysAllow() {
        let pattern = confirmation.allowlistOptions.first?.pattern ?? ""
        if pattern.isEmpty {
            onAllow()
            return
        }
        if needsScopeChoice {
            pendingPattern = pattern
            showScopePickerMenu = true
        } else {
            let scope = confirmation.scopeOptions.first?.scope ?? ""
            if !scope.isEmpty {
                onAlwaysAllow(confirmation.requestId, pattern, scope, alwaysAllowDecision)
            } else {
                onAllow()
            }
        }
    }

    @ViewBuilder
    private func confirmationButton(_ label: String, isPrimary: Bool, isDanger: Bool, isKeyboardSelected: Bool = false, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Text(label)
                .font(VFont.caption)
                .foregroundColor(isPrimary || isDanger ? .white : VColor.textSecondary)
                .padding(.horizontal, VSpacing.sm)
                .padding(.vertical, VSpacing.xxs + 1)
                .background(isDanger ? Color(hex: 0xC1421B) : isPrimary ? Sage._600 : Color.clear)
                .clipShape(RoundedRectangle(cornerRadius: VRadius.sm))
                .overlay(
                    RoundedRectangle(cornerRadius: VRadius.sm)
                        .stroke(
                            isKeyboardSelected ? VColor.accent : (isPrimary || isDanger ? Color.clear : VColor.surfaceBorder),
                            lineWidth: isKeyboardSelected ? 2 : 1
                        )
                )
        }
        .buttonStyle(.plain)
    }

    // MARK: - Always Allow Button

    @ViewBuilder
    private var alwaysAllowInlineButton: some View {
        if hasRuleOptions && confirmation.allowlistOptions.count > 1 {
            alwaysAllowDropdown
        } else {
            let patternDesc = confirmation.allowlistOptions.first?.description ?? ""
            confirmationButton("Always Allow", isPrimary: false, isDanger: false, isKeyboardSelected: keyboardModel?.selectedAction == .alwaysAllow) {
                handleSingleOptionAlwaysAllow()
            }
            .help(patternDesc.isEmpty ? "Always allow this action" : patternDesc)
            .popover(isPresented: $showScopePickerMenu, arrowEdge: .bottom) {
                scopePickerContent
            }
        }
    }

    // MARK: - Always Allow Dropdown

    @ViewBuilder
    private var alwaysAllowDropdown: some View {
        confirmationButton("Always Allow", isPrimary: false, isDanger: false, isKeyboardSelected: keyboardModel?.selectedAction == .alwaysAllow) {
            withAnimation(VAnimation.fast) {
                pendingPattern = nil
                showAlwaysAllowMenu.toggle()
            }
        }
        .popover(isPresented: $showAlwaysAllowMenu, arrowEdge: .bottom) {
            VStack(alignment: .leading, spacing: 0) {
                if let pending = pendingPattern, needsScopeChoice {
                    // Scope selection step after pattern was chosen
                    HStack(spacing: VSpacing.xs) {
                        Button {
                            pendingPattern = nil
                        } label: {
                            Image(systemName: "chevron.left")
                                .font(.system(size: 10, weight: .semibold))
                                .foregroundColor(VColor.textMuted)
                        }
                        .buttonStyle(.plain)

                        Text("Choose scope")
                            .font(VFont.captionMedium)
                            .foregroundColor(VColor.textMuted)
                    }
                    .padding(.horizontal, VSpacing.sm)
                    .padding(.vertical, VSpacing.xs)

                    Divider()
                        .background(VColor.divider)

                    ForEach(Array(confirmation.scopeOptions.enumerated()), id: \.element.scope) { index, scopeOption in
                        ScopePickerRow(label: scopeOption.label) {
                            showAlwaysAllowMenu = false
                            pendingPattern = nil
                            onAlwaysAllow(confirmation.requestId, pending, scopeOption.scope, alwaysAllowDecision)
                        }

                        if index < confirmation.scopeOptions.count - 1 {
                            Divider()
                                .background(VColor.divider)
                        }
                    }
                } else {
                    // Pattern selection step
                    ForEach(Array(confirmation.allowlistOptions.enumerated()), id: \.element.pattern) { index, option in
                        AlwaysAllowRow(label: option.description) {
                            if option.pattern.isEmpty {
                                showAlwaysAllowMenu = false
                                onAllow()
                            } else if needsScopeChoice {
                                pendingPattern = option.pattern
                            } else {
                                showAlwaysAllowMenu = false
                                let scope = confirmation.scopeOptions.first?.scope ?? ""
                                if !scope.isEmpty {
                                    onAlwaysAllow(confirmation.requestId, option.pattern, scope, alwaysAllowDecision)
                                } else {
                                    onAllow()
                                }
                            }
                        }

                        if index < confirmation.allowlistOptions.count - 1 {
                            Divider()
                                .background(VColor.divider)
                        }
                    }
                }
            }
            .padding(VSpacing.xs)
            .frame(minWidth: 200)
        }
    }

    // MARK: - Scope Picker (inline button popover)

    @ViewBuilder
    private var scopePickerContent: some View {
        VStack(alignment: .leading, spacing: 0) {
            Text("Choose scope")
                .font(VFont.captionMedium)
                .foregroundColor(VColor.textMuted)
                .padding(.horizontal, VSpacing.sm)
                .padding(.vertical, VSpacing.xs)

            Divider()
                .background(VColor.divider)

            ForEach(Array(confirmation.scopeOptions.enumerated()), id: \.element.scope) { index, scopeOption in
                ScopePickerRow(label: scopeOption.label) {
                    showScopePickerMenu = false
                    if let pattern = pendingPattern {
                        onAlwaysAllow(confirmation.requestId, pattern, scopeOption.scope, alwaysAllowDecision)
                        pendingPattern = nil
                    }
                }

                if index < confirmation.scopeOptions.count - 1 {
                    Divider()
                        .background(VColor.divider)
                }
            }
        }
        .padding(VSpacing.xs)
        .frame(minWidth: 180)
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

            Text(confirmation.state == .approved
                 ? "\(confirmation.toolCategory) allowed"
                 : confirmation.state == .denied
                 ? "\(confirmation.toolCategory) denied"
                 : "Timed out")
                .font(VFont.caption)
                .foregroundColor(VColor.textSecondary)

            Spacer()
        }
    }

}

// MARK: - Always Allow Row

private struct AlwaysAllowRow: View {
    let label: String
    let action: () -> Void

    @State private var isHovered = false

    var body: some View {
        Button(action: action) {
            Text(label)
                .font(VFont.body)
                .foregroundColor(VColor.textPrimary)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.vertical, VSpacing.sm)
                .padding(.horizontal, VSpacing.sm)
                .background(
                    RoundedRectangle(cornerRadius: VRadius.sm)
                        .fill(isHovered ? VColor.surfaceBorder.opacity(0.5) : .clear)
                )
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        #if os(macOS)
        .onHover { hovering in
            isHovered = hovering
            if hovering { NSCursor.pointingHand.set() }
            else { NSCursor.arrow.set() }
        }
        #else
        .onHover { isHovered = $0 }
        #endif
    }
}

// MARK: - Scope Picker Row

private struct ScopePickerRow: View {
    let label: String
    let action: () -> Void

    @State private var isHovered = false

    var body: some View {
        Button(action: action) {
            Text(label)
                .font(VFont.body)
                .foregroundColor(VColor.textPrimary)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.vertical, VSpacing.sm)
                .padding(.horizontal, VSpacing.sm)
                .background(
                    RoundedRectangle(cornerRadius: VRadius.sm)
                        .fill(isHovered ? VColor.surfaceBorder.opacity(0.5) : .clear)
                )
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        #if os(macOS)
        .onHover { hovering in
            isHovered = hovering
            if hovering { NSCursor.pointingHand.set() }
            else { NSCursor.arrow.set() }
        }
        #else
        .onHover { isHovered = $0 }
        #endif
    }
}

#if DEBUG
#Preview("ToolConfirmationBubble") {
    VStack(spacing: VSpacing.lg) {
        // Bash command — medium risk, pending
        ToolConfirmationBubble(
            confirmation: ToolConfirmationData(
                requestId: "test-bash-medium",
                toolName: "host_bash",
                input: ["command": AnyCodable("npm install express")],
                riskLevel: "medium",
                allowlistOptions: [
                    ConfirmationRequestMessage.ConfirmationAllowlistOption(label: "exact", description: "This exact command", pattern: "npm install express"),
                ],
                scopeOptions: [
                    ConfirmationRequestMessage.ConfirmationScopeOption(label: "This project", scope: "project"),
                ],
                executionTarget: "host"
            ),
            onAllow: {},
            onDeny: {},
            onAlwaysAllow: { _, _, _, _ in }
        )

        // File write — high risk, pending
        ToolConfirmationBubble(
            confirmation: ToolConfirmationData(
                requestId: "test-write-high",
                toolName: "host_file_write",
                input: ["path": AnyCodable("/Users/me/project/main.swift")],
                riskLevel: "high",
                executionTarget: "host"
            ),
            onAllow: {},
            onDeny: {},
            onAlwaysAllow: { _, _, _, _ in }
        )

        // Bash — low risk, pending
        ToolConfirmationBubble(
            confirmation: ToolConfirmationData(
                requestId: "test-bash-low",
                toolName: "host_bash",
                input: ["command": AnyCodable("ls -lt ~/Downloads/ | head -50")],
                riskLevel: "low",
                executionTarget: "host"
            ),
            onAllow: {},
            onDeny: {},
            onAlwaysAllow: { _, _, _, _ in }
        )

        // Always-allow dropdown — medium risk
        ToolConfirmationBubble(
            confirmation: ToolConfirmationData(
                requestId: "test-dropdown",
                toolName: "host_bash",
                input: ["command": AnyCodable("ls -la ~/Library/Application\\ Support/")],
                riskLevel: "medium",
                allowlistOptions: [
                    ConfirmationRequestMessage.ConfirmationAllowlistOption(label: "exact", description: "This exact command", pattern: "ls -la ~/Library/Application\\ Support/"),
                    ConfirmationRequestMessage.ConfirmationAllowlistOption(label: "prefix", description: "Any \"ls -la ~/Library/Application\\\" command", pattern: "ls -la ~/Library/Application*"),
                    ConfirmationRequestMessage.ConfirmationAllowlistOption(label: "tool", description: "Any ls command", pattern: "ls *"),
                ],
                scopeOptions: [
                    ConfirmationRequestMessage.ConfirmationScopeOption(label: "This project", scope: "project"),
                ],
                executionTarget: "host"
            ),
            onAllow: {},
            onDeny: {},
            onAlwaysAllow: { _, _, _, _ in }
        )

        // Collapsed — approved
        ToolConfirmationBubble(
            confirmation: ToolConfirmationData(
                requestId: "test-approved",
                toolName: "host_bash",
                input: ["command": AnyCodable("npm install")],
                riskLevel: "medium",
                state: .approved
            ),
            onAllow: {},
            onDeny: {},
            onAlwaysAllow: { _, _, _, _ in }
        )

        // Collapsed — denied
        ToolConfirmationBubble(
            confirmation: ToolConfirmationData(
                requestId: "test-denied",
                toolName: "host_file_write",
                input: ["path": AnyCodable("/etc/hosts")],
                riskLevel: "high",
                state: .denied
            ),
            onAllow: {},
            onDeny: {},
            onAlwaysAllow: { _, _, _, _ in }
        )

        // Unknown tool fallback
        ToolConfirmationBubble(
            confirmation: ToolConfirmationData(
                requestId: "test-unknown",
                toolName: "custom_plugin_action",
                input: ["query": AnyCodable("test")],
                riskLevel: "medium"
            ),
            onAllow: {},
            onDeny: {},
            onAlwaysAllow: { _, _, _, _ in }
        )

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
            onAlwaysAllow: { _, _, _, _ in }
        )

        // Inline always-allow with multiple scopes (scope picker on click)
        ToolConfirmationBubble(
            confirmation: ToolConfirmationData(
                requestId: "test-inline-multi-scope",
                toolName: "host_bash",
                input: ["command": AnyCodable("npm test")],
                riskLevel: "medium",
                allowlistOptions: [
                    ConfirmationRequestMessage.ConfirmationAllowlistOption(label: "exact", description: "This exact command", pattern: "npm test"),
                ],
                scopeOptions: [
                    ConfirmationRequestMessage.ConfirmationScopeOption(label: "This project", scope: "project"),
                    ConfirmationRequestMessage.ConfirmationScopeOption(label: "Everywhere", scope: "everywhere"),
                ],
                executionTarget: "host"
            ),
            onAllow: {},
            onDeny: {},
            onAlwaysAllow: { _, _, _, _ in }
        )

        // Dropdown always-allow with multiple scopes (two-step selection)
        ToolConfirmationBubble(
            confirmation: ToolConfirmationData(
                requestId: "test-dropdown-multi-scope",
                toolName: "host_bash",
                input: ["command": AnyCodable("git push origin main")],
                riskLevel: "medium",
                allowlistOptions: [
                    ConfirmationRequestMessage.ConfirmationAllowlistOption(label: "exact", description: "This exact command", pattern: "git push origin main"),
                    ConfirmationRequestMessage.ConfirmationAllowlistOption(label: "prefix", description: "Any \"git push\" command", pattern: "git push *"),
                    ConfirmationRequestMessage.ConfirmationAllowlistOption(label: "tool", description: "Any git command", pattern: "git *"),
                ],
                scopeOptions: [
                    ConfirmationRequestMessage.ConfirmationScopeOption(label: "This project", scope: "project"),
                    ConfirmationRequestMessage.ConfirmationScopeOption(label: "Everywhere", scope: "everywhere"),
                ],
                executionTarget: "host"
            ),
            onAllow: {},
            onDeny: {},
            onAlwaysAllow: { _, _, _, _ in }
        )
    }
    .padding(VSpacing.xl)
    .background(VColor.background)
}
#endif
