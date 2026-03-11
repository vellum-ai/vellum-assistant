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

    @State private var showDiff = false
    @State private var showAlwaysAllowMenu = false
    @State private var showTechnicalDetails = true
    /// Tracks a selected pattern while waiting for the user to pick a scope.
    @State private var pendingPattern: String?
    @State private var showScopePickerMenu = false
    @State private var keyboardModel: ToolConfirmationKeyboardModel?
    @State private var popoverKeyboardModel: ToolConfirmationPopoverKeyboardModel?
    @AppStorage("hasSeenCommandExplanation") private var hasSeenCommandExplanation = false
    #if os(macOS)
    @State private var keyMonitor: Any?
    #endif

    public init(confirmation: ToolConfirmationData, isKeyboardActive: Bool = true, onAllow: @escaping () -> Void, onDeny: @escaping () -> Void, onAlwaysAllow: @escaping (String, String, String, String) -> Void, onTemporaryAllow: ((String, String) -> Void)? = nil) {
        self.confirmation = confirmation
        self.isKeyboardActive = isKeyboardActive
        self.onAllow = onAllow
        self.onDeny = onDeny
        self.onAlwaysAllow = onAlwaysAllow
        self.onTemporaryAllow = onTemporaryAllow
    }

    private var hasRuleOptions: Bool {
        !confirmation.allowlistOptions.isEmpty
    }

    private var needsScopeChoice: Bool {
        !confirmation.scopeOptions.isEmpty
    }

    private var isCommandTool: Bool {
        confirmation.toolName == "bash" || confirmation.toolName == "host_bash"
    }

    private var isDecided: Bool {
        confirmation.state != .pending
    }

    private var hasAllow10m: Bool {
        confirmation.temporaryOptionsAvailable.contains("allow_10m")
    }

    private var hasAllowThread: Bool {
        confirmation.temporaryOptionsAvailable.contains("allow_thread")
    }

    /// The decision value to send when "Always Allow" is clicked.
    /// High-risk prompts use `always_allow_high_risk` so the daemon persists
    /// a rule with `allowHighRisk: true`.
    private var alwaysAllowDecision: String {
        confirmation.riskLevel.lowercased() == "high" ? "always_allow_high_risk" : "always_allow"
    }

    /// The full input preview for the inline display (all key-value pairs).
    private var inlinePreviewText: String? {
        let preview = confirmation.fullInputPreview
        return preview.isEmpty ? nil : preview
    }

    /// Label shown in the collapsed state after a decision is made.
    private var collapsedLabel: String {
        switch confirmation.state {
        case .approved:
            switch confirmation.approvedDecision {
            case "allow_10m":
                return "\(confirmation.toolCategory) allowed for 10 minutes"
            case "allow_thread":
                return "\(confirmation.toolCategory) allowed for this thread"
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
                VIconView(.shield, size: 16)
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

                VButton(label: "I\u{2019}ve granted it", style: .tertiary) {
                    onAllow()
                }

                VButton(label: "Skip", style: .tertiary) {
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

    // MARK: - Tool Permission (pending)

    @ViewBuilder
    private var commandExplanationBanner: some View {
        HStack(alignment: .top, spacing: VSpacing.sm) {
            VIconView(.info, size: 14)
                .foregroundColor(VColor.accent)
                .padding(.top, 1)

            VStack(alignment: .leading, spacing: VSpacing.xs) {
                Text("What is this?")
                    .font(VFont.captionMedium)
                    .foregroundColor(VColor.textPrimary)

                Text("Sometimes your assistant needs to run commands on your computer to complete tasks \u{2014} like installing software, checking settings, or organizing files. You\u{2019}ll always be asked for permission first, and nothing runs without your approval.")
                    .font(VFont.caption)
                    .foregroundColor(VColor.textSecondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .padding(VSpacing.sm)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(
            RoundedRectangle(cornerRadius: VRadius.sm)
                .fill(VColor.accent.opacity(0.08))
        )
    }

    @ViewBuilder
    private var pendingContent: some View {
        VStack(alignment: .leading, spacing: VSpacing.sm) {
            // Bold non-technical question
            Text(confirmation.humanDescription)
                .font(VFont.bodyBold)
                .foregroundColor(VColor.textPrimary)

            // First-time educational banner for command confirmations
            if isCommandTool && !hasSeenCommandExplanation {
                commandExplanationBanner
            }

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
                        VIconView(.chevronRight, size: 9)
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
            VIconView(confirmation.toolCategoryIcon, size: 12)
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
        codePreviewBlock(preview, maxHeight: 220)
    }

    @ViewBuilder
    private func codePreviewBlock(_ content: String, maxHeight: CGFloat) -> some View {
        ScrollView {
            Text(content)
                .font(VFont.monoSmall)
                .foregroundColor(VColor.textSecondary)
                .frame(maxWidth: .infinity, alignment: .leading)
                .textSelection(.enabled)
        }
        .frame(maxHeight: maxHeight)
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
                    VIconView(showDiff ? .chevronUp : .chevronDown, size: 8)
                        .foregroundColor(VColor.textMuted)
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel(showDiff ? "Hide diff" : "View diff")

            if showDiff, let diffInfo = confirmation.diff {
                let computedDiff = confirmation.unifiedDiffPreview ?? ""
                let diffBody = computedDiff.isEmpty ? diffInfo.newContent : computedDiff
                VStack(alignment: .leading, spacing: VSpacing.xs) {
                    Text(diffInfo.filePath)
                        .font(VFont.monoSmall)
                        .foregroundColor(VColor.textMuted)

                    codePreviewBlock(diffBody, maxHeight: 260)
                }
                .textSelection(.enabled)
                .transition(.opacity.combined(with: .move(edge: .top)))
            }
        }
    }

    // MARK: - Button Row

    /// Build the ordered list of top-level actions based on current confirmation state.
    /// Temporary options come first (matching visual top-to-bottom, left-to-right order).
    private var topLevelActions: [ToolConfirmationKeyboardModel.Action] {
        var actions: [ToolConfirmationKeyboardModel.Action] = []
        if hasAllow10m { actions.append(.allow10m) }
        if hasAllowThread { actions.append(.allowThread) }
        actions.append(.allowOnce)
        if hasRuleOptions && confirmation.persistentDecisionsAllowed {
            actions.append(.alwaysAllow)
        }
        actions.append(.dontAllow)
        return actions
    }

    private var hasTemporaryOptions: Bool {
        hasAllow10m || hasAllowThread
    }

    @ViewBuilder
    private var buttonRow: some View {
        let actions = topLevelActions
        VStack(alignment: .leading, spacing: VSpacing.sm) {
            // Top group: temporary approval options (approve all future actions)
            if hasTemporaryOptions {
                VStack(alignment: .leading, spacing: VSpacing.xs) {
                    Text("Approve all actions")
                        .font(VFont.caption)
                        .foregroundColor(VColor.textMuted)
                    HStack(spacing: VSpacing.xs) {
                        if hasAllow10m {
                            confirmationButton(
                                "Allow for 10 minutes",
                                isPrimary: true,
                                isDanger: false,
                                isKeyboardSelected: keyboardModel?.selectedAction == .allow10m
                            ) { markCommandExplanationSeen(); onTemporaryAllow?(confirmation.requestId, "allow_10m") }
                        }
                        if hasAllowThread {
                            confirmationButton(
                                "Allow for this thread",
                                isPrimary: true,
                                isDanger: false,
                                isKeyboardSelected: keyboardModel?.selectedAction == .allowThread
                            ) { markCommandExplanationSeen(); onTemporaryAllow?(confirmation.requestId, "allow_thread") }
                        }
                    }
                }
            }
            // Bottom group: per-action options
            VStack(alignment: .leading, spacing: VSpacing.xs) {
                if hasTemporaryOptions {
                    Text("This action only")
                        .font(VFont.caption)
                        .foregroundColor(VColor.textMuted)
                }
                HStack(spacing: VSpacing.xs) {
                    confirmationButton(
                        "Allow Once",
                        isPrimary: !hasTemporaryOptions,
                        isDanger: false,
                        isKeyboardSelected: keyboardModel?.selectedAction == .allowOnce
                    ) { markCommandExplanationSeen(); onAllow() }
                    if hasRuleOptions && confirmation.persistentDecisionsAllowed { alwaysAllowInlineButton }
                    confirmationButton(
                        "Don\u{2019}t Allow",
                        isPrimary: false,
                        isDanger: false,
                        isKeyboardSelected: keyboardModel?.selectedAction == .dontAllow
                    ) { markCommandExplanationSeen(); onDeny() }
                    Spacer()
                }
            }
        }
        .onAppear {
            if isKeyboardActive {
                #if os(macOS)
                installKeyMonitor(actions: actions)
                #else
                keyboardModel = ToolConfirmationKeyboardModel(actions: actions)
                #endif
            }
        }
        .onDisappear {
            popoverKeyboardModel = nil
            #if os(macOS)
            removeKeyMonitor()
            #endif
        }
        .onChange(of: isKeyboardActive) {
            if isKeyboardActive {
                #if os(macOS)
                installKeyMonitor(actions: actions)
                #else
                keyboardModel = ToolConfirmationKeyboardModel(actions: actions)
                #endif
            } else {
                #if os(macOS)
                removeKeyMonitor()
                #endif
                keyboardModel = nil
                popoverKeyboardModel = nil
                showAlwaysAllowMenu = false
                showScopePickerMenu = false
                pendingPattern = nil
            }
        }
    }

    // MARK: - Key Monitor (macOS)

    #if os(macOS)
    /// The modifier flags we consider "intentional". Caps Lock, NumericPad, and
    /// Function are excluded because they can be set passively (e.g. Caps Lock
    /// is on, or the key physically sits on the numpad / function row) and
    /// should not prevent keyboard shortcuts from working.
    private static let intentionalModifiers: NSEvent.ModifierFlags = [.shift, .control, .option, .command]

    private func installKeyMonitor(actions: [ToolConfirmationKeyboardModel.Action]) {
        removeKeyMonitor()
        keyboardModel = ToolConfirmationKeyboardModel(actions: actions)
        keyMonitor = NSEvent.addLocalMonitorForEvents(matching: .keyDown) { event in
            // If an editable text view (e.g. the composer) is the first responder,
            // let the event pass through so it can handle Enter/Tab/Escape normally.
            // Non-editable text views (e.g. selectable command previews inside the
            // confirmation bubble) don't need these keys, so we still intercept them.
            if let firstResponder = NSApp.keyWindow?.firstResponder as? NSTextView,
               firstResponder.isEditable {
                return event
            }
            let mods = event.modifierFlags.intersection(Self.intentionalModifiers)
            // Nested popover is open — handle up/down/enter/escape within it
            if showAlwaysAllowMenu || showScopePickerMenu {
                return handlePopoverKey(event, mods: mods)
            }
            // Top-level button row navigation
            switch event.keyCode {
            case 48 where mods == .shift:
                // Shift+Tab — move left
                keyboardModel?.moveLeft()
                return nil
            case 48 where mods.isEmpty:
                // Plain Tab — move right (modified Tab passes through)
                keyboardModel?.moveRight()
                return nil
            case 36 where mods.isEmpty, 76 where mods.isEmpty:
                // Plain Return / numpad Enter — activate (modified Enter passes through, e.g. Shift+Enter for newline)
                if let action = keyboardModel?.selectedAction {
                    activateAction(action)
                }
                return nil
            case 53 where mods.isEmpty:
                // Plain Escape — deny (modified Escape passes through)
                activateAction(.dontAllow)
                return nil
            default:
                return event
            }
        }
    }

    /// Handle key events when a nested popover (Always Allow dropdown or
    /// scope picker) is open.
    private func handlePopoverKey(_ event: NSEvent, mods: NSEvent.ModifierFlags) -> NSEvent? {
        switch event.keyCode {
        case 126:
            // Up arrow
            popoverKeyboardModel?.moveUp()
            return nil
        case 125:
            // Down arrow
            popoverKeyboardModel?.moveDown()
            return nil
        case 36 where mods.isEmpty, 76 where mods.isEmpty:
            // Plain Return / numpad Enter — activate selected row (modified Enter passes through)
            activatePopoverSelection()
            return nil
        case 53 where mods.isEmpty:
            // Plain Escape — back or close (modified Escape passes through)
            handlePopoverEscape()
            return nil
        default:
            return event
        }
    }

    /// Activate the currently selected row in the nested popover.
    private func activatePopoverSelection() {
        markCommandExplanationSeen()
        guard let model = popoverKeyboardModel else { return }
        let index = model.selectedIndex

        if showAlwaysAllowMenu {
            if pendingPattern != nil && needsScopeChoice {
                // We're in the scope step of the dropdown
                guard index < confirmation.scopeOptions.count else { return }
                let scopeOption = confirmation.scopeOptions[index]
                showAlwaysAllowMenu = false
                let pattern = pendingPattern!
                pendingPattern = nil
                popoverKeyboardModel = nil
                onAlwaysAllow(confirmation.requestId, pattern, scopeOption.scope, alwaysAllowDecision)
            } else {
                // We're in the pattern step of the dropdown
                guard index < confirmation.allowlistOptions.count else { return }
                let option = confirmation.allowlistOptions[index]
                if option.pattern.isEmpty {
                    showAlwaysAllowMenu = false
                    popoverKeyboardModel = nil
                    onAllow()
                } else if needsScopeChoice {
                    pendingPattern = option.pattern
                    popoverKeyboardModel = ToolConfirmationPopoverKeyboardModel(
                        mode: .scopes,
                        itemCount: confirmation.scopeOptions.count
                    )
                } else {
                    // No scope options (non-scoped tool) — auto-use "everywhere"
                    showAlwaysAllowMenu = false
                    popoverKeyboardModel = nil
                    onAlwaysAllow(confirmation.requestId, option.pattern, "everywhere", alwaysAllowDecision)
                }
            }
        } else if showScopePickerMenu {
            // Inline scope picker
            guard index < confirmation.scopeOptions.count else { return }
            let scopeOption = confirmation.scopeOptions[index]
            showScopePickerMenu = false
            popoverKeyboardModel = nil
            if let pattern = pendingPattern {
                onAlwaysAllow(confirmation.requestId, pattern, scopeOption.scope, alwaysAllowDecision)
                pendingPattern = nil
            }
        }
    }

    /// Handle Escape in a nested popover.
    private func handlePopoverEscape() {
        guard let model = popoverKeyboardModel else { return }
        switch model.handleEscape() {
        case .backToPatterns:
            if showScopePickerMenu {
                // Standalone scope picker has no pattern list to return to — just close.
                showScopePickerMenu = false
                popoverKeyboardModel = nil
                pendingPattern = nil
            } else {
                pendingPattern = nil
                popoverKeyboardModel = ToolConfirmationPopoverKeyboardModel(
                    mode: .patterns,
                    itemCount: confirmation.allowlistOptions.count
                )
            }
        case .closePopover:
            if showAlwaysAllowMenu {
                showAlwaysAllowMenu = false
            }
            if showScopePickerMenu {
                showScopePickerMenu = false
            }
            popoverKeyboardModel = nil
        }
    }

    private func removeKeyMonitor() {
        if let monitor = keyMonitor {
            NSEvent.removeMonitor(monitor)
            keyMonitor = nil
        }
    }
    #endif

    /// Persist the command explanation banner dismissal so it only shows once.
    /// Called when the user takes any action on the confirmation (approve, deny,
    /// or always-allow) rather than on view disappearance, because `onDisappear`
    /// fires on scroll/recycle in a `LazyVStack` and would dismiss the banner
    /// before the user has actually seen it.
    private func markCommandExplanationSeen() {
        if isCommandTool && !hasSeenCommandExplanation {
            hasSeenCommandExplanation = true
        }
    }

    /// Trigger the callback for a given top-level action.
    private func activateAction(_ action: ToolConfirmationKeyboardModel.Action) {
        markCommandExplanationSeen()
        switch action {
        case .allowOnce:
            onAllow()
        case .allow10m:
            onTemporaryAllow?(confirmation.requestId, "allow_10m")
        case .allowThread:
            onTemporaryAllow?(confirmation.requestId, "allow_thread")
        case .alwaysAllow:
            if confirmation.allowlistOptions.count > 1 {
                withAnimation(VAnimation.fast) {
                    pendingPattern = nil
                    showAlwaysAllowMenu.toggle()
                }
                if showAlwaysAllowMenu {
                    popoverKeyboardModel = ToolConfirmationPopoverKeyboardModel(
                        mode: .patterns,
                        itemCount: confirmation.allowlistOptions.count
                    )
                } else {
                    popoverKeyboardModel = nil
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
        markCommandExplanationSeen()
        let pattern = confirmation.allowlistOptions.first?.pattern ?? ""
        if pattern.isEmpty {
            onAllow()
            return
        }
        if needsScopeChoice {
            pendingPattern = pattern
            showScopePickerMenu = true
            popoverKeyboardModel = ToolConfirmationPopoverKeyboardModel(
                mode: .scopes,
                itemCount: confirmation.scopeOptions.count
            )
        } else {
            // No scope options (non-scoped tool) — auto-use "everywhere"
            onAlwaysAllow(confirmation.requestId, pattern, "everywhere", alwaysAllowDecision)
        }
    }

    /// Convenience wrapper around the shared `ApprovalActionButton` to preserve
    /// call-site compatibility within the existing button row logic.
    @ViewBuilder
    private func confirmationButton(_ label: String, isPrimary: Bool, isDanger: Bool, isKeyboardSelected: Bool = false, action: @escaping () -> Void) -> some View {
        ApprovalActionButton(
            label: label,
            isPrimary: isPrimary,
            isDanger: isDanger,
            isKeyboardSelected: isKeyboardSelected,
            action: action
        )
    }

    // MARK: - Always Allow Button

    @ViewBuilder
    private var alwaysAllowInlineButton: some View {
        if !confirmation.allowlistOptions.isEmpty && confirmation.allowlistOptions.count > 1 {
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
            if showAlwaysAllowMenu {
                popoverKeyboardModel = ToolConfirmationPopoverKeyboardModel(
                    mode: .patterns,
                    itemCount: confirmation.allowlistOptions.count
                )
            } else {
                popoverKeyboardModel = nil
            }
        }
        .popover(isPresented: $showAlwaysAllowMenu, arrowEdge: .bottom) {
            VStack(alignment: .leading, spacing: 0) {
                if let pending = pendingPattern, needsScopeChoice {
                    // Scope selection step after pattern was chosen
                    HStack(spacing: VSpacing.xs) {
                        Button {
                            pendingPattern = nil
                            popoverKeyboardModel = ToolConfirmationPopoverKeyboardModel(
                                mode: .patterns,
                                itemCount: confirmation.allowlistOptions.count
                            )
                        } label: {
                            VIconView(.chevronLeft, size: 10)
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
                        ScopePickerRow(
                            label: scopeOption.label,
                            isKeyboardSelected: popoverKeyboardModel?.mode == .scopes && popoverKeyboardModel?.selectedIndex == index
                        ) {
                            markCommandExplanationSeen()
                            showAlwaysAllowMenu = false
                            pendingPattern = nil
                            popoverKeyboardModel = nil
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
                        AlwaysAllowRow(
                            title: option.label,
                            subtitle: option.description,
                            isKeyboardSelected: popoverKeyboardModel?.mode == .patterns && popoverKeyboardModel?.selectedIndex == index
                        ) {
                            markCommandExplanationSeen()
                            if option.pattern.isEmpty {
                                showAlwaysAllowMenu = false
                                popoverKeyboardModel = nil
                                onAllow()
                            } else if needsScopeChoice {
                                pendingPattern = option.pattern
                                popoverKeyboardModel = ToolConfirmationPopoverKeyboardModel(
                                    mode: .scopes,
                                    itemCount: confirmation.scopeOptions.count
                                )
                            } else {
                                // No scope options (non-scoped tool) — auto-use "everywhere"
                                showAlwaysAllowMenu = false
                                popoverKeyboardModel = nil
                                onAlwaysAllow(confirmation.requestId, option.pattern, "everywhere", alwaysAllowDecision)
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
                ScopePickerRow(
                    label: scopeOption.label,
                    isKeyboardSelected: popoverKeyboardModel?.mode == .scopes && popoverKeyboardModel?.selectedIndex == index
                ) {
                    markCommandExplanationSeen()
                    showScopePickerMenu = false
                    popoverKeyboardModel = nil
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
        ApprovalStatusRow(
            outcome: collapsedOutcome,
            label: collapsedLabel
        )
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

// MARK: - Always Allow Row

private struct AlwaysAllowRow: View {
    let title: String
    let subtitle: String
    var isKeyboardSelected: Bool = false
    let action: () -> Void

    @State private var isHovered = false

    var body: some View {
        Button(action: action) {
            VStack(alignment: .leading, spacing: 2) {
                Text(title)
                    .font(VFont.monoSmall)
                    .foregroundColor(VColor.textPrimary)
                if !subtitle.isEmpty {
                    Text(subtitle)
                        .font(VFont.caption)
                        .foregroundColor(VColor.textMuted)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.vertical, VSpacing.sm)
            .padding(.horizontal, VSpacing.sm)
            .background(
                RoundedRectangle(cornerRadius: VRadius.sm)
                    .fill(isHovered || isKeyboardSelected ? VColor.surfaceBorder.opacity(0.5) : .clear)
            )
            .overlay(
                RoundedRectangle(cornerRadius: VRadius.sm)
                    .stroke(isKeyboardSelected ? VColor.accent : .clear, lineWidth: 2)
            )
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .onHover { hovering in
            isHovered = hovering
        }
        .pointerCursor()
    }
}

// MARK: - Scope Picker Row

private struct ScopePickerRow: View {
    let label: String
    var isKeyboardSelected: Bool = false
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
                        .fill(isHovered || isKeyboardSelected ? VColor.surfaceBorder.opacity(0.5) : .clear)
                )
                .overlay(
                    RoundedRectangle(cornerRadius: VRadius.sm)
                        .stroke(isKeyboardSelected ? VColor.accent : .clear, lineWidth: 2)
                )
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .onHover { hovering in
            isHovered = hovering
        }
        .pointerCursor()
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
                    ConfirmationRequestAllowlistOption(label: "exact", description: "This exact command", pattern: "npm install express"),
                ],
                scopeOptions: [
                    ConfirmationRequestScopeOption(label: "This project", scope: "project"),
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
                    ConfirmationRequestAllowlistOption(label: "exact", description: "This exact command", pattern: "ls -la ~/Library/Application\\ Support/"),
                    ConfirmationRequestAllowlistOption(label: "prefix", description: "Any \"ls -la ~/Library/Application\\\" command", pattern: "ls -la ~/Library/Application*"),
                    ConfirmationRequestAllowlistOption(label: "tool", description: "Any ls command", pattern: "ls *"),
                ],
                scopeOptions: [
                    ConfirmationRequestScopeOption(label: "This project", scope: "project"),
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
                    ConfirmationRequestAllowlistOption(label: "exact", description: "This exact command", pattern: "npm test"),
                ],
                scopeOptions: [
                    ConfirmationRequestScopeOption(label: "This project", scope: "project"),
                    ConfirmationRequestScopeOption(label: "Everywhere", scope: "everywhere"),
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
                    ConfirmationRequestAllowlistOption(label: "exact", description: "This exact command", pattern: "git push origin main"),
                    ConfirmationRequestAllowlistOption(label: "prefix", description: "Any \"git push\" command", pattern: "git push *"),
                    ConfirmationRequestAllowlistOption(label: "tool", description: "Any git command", pattern: "git *"),
                ],
                scopeOptions: [
                    ConfirmationRequestScopeOption(label: "This project", scope: "project"),
                    ConfirmationRequestScopeOption(label: "Everywhere", scope: "everywhere"),
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
