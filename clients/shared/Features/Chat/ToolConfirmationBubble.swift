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
    @State private var showTechnicalDetails = false
    /// Tracks a selected pattern while waiting for the user to pick a scope.
    @State private var pendingPattern: String?
    @State private var showScopePickerMenu = false
    @State private var keyboardModel: ToolConfirmationKeyboardModel?
    @State private var popoverKeyboardModel: ToolConfirmationPopoverKeyboardModel?
    @AppStorage("hasSeenCommandExplanation") private var hasSeenCommandExplanation = false
    @AppStorage("preferredAllowAction") private var preferredAllowAction: String = "allow_10m"
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

    private var hasAllowConversation: Bool {
        confirmation.temporaryOptionsAvailable.contains("allow_conversation")
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
                    .foregroundColor(VColor.primaryBase)

                Text(confirmation.permissionFriendlyName)
                    .font(VFont.bodyBold)
                    .foregroundColor(VColor.contentDefault)
            }

            Text(confirmation.humanDescription)
                .font(VFont.body)
                .foregroundColor(VColor.contentSecondary)

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
                .foregroundColor(VColor.primaryBase)
                .padding(.top, 1)

            VStack(alignment: .leading, spacing: VSpacing.xs) {
                Text("What is this?")
                    .font(VFont.captionMedium)
                    .foregroundColor(VColor.contentDefault)

                Text("Sometimes your assistant needs to run commands on your computer to complete tasks \u{2014} like installing software, checking settings, or organizing files. You\u{2019}ll always be asked for permission first, and nothing runs without your approval.")
                    .font(VFont.caption)
                    .foregroundColor(VColor.contentSecondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .padding(VSpacing.sm)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(
            RoundedRectangle(cornerRadius: VRadius.sm)
                .fill(VColor.primaryBase.opacity(0.08))
        )
    }

    @ViewBuilder
    private var pendingContent: some View {
        let actions = topLevelActions
        VStack(alignment: .leading, spacing: VSpacing.sm) {
            // Title + action buttons inline
            HStack(alignment: .top, spacing: VSpacing.sm) {
                Text(confirmation.humanDescription)
                    .font(VFont.bodyBold)
                    .foregroundColor(VColor.contentDefault)
                    .fixedSize(horizontal: false, vertical: true)

                Spacer(minLength: VSpacing.md)

                HStack(spacing: VSpacing.sm) {
                    allowSplitButton
                        .overlay(
                            RoundedRectangle(cornerRadius: VRadius.md)
                                .stroke(VColor.primaryBase, lineWidth: isPrimaryAllowKeyboardSelected ? 2 : 0)
                        )

                    VButton(label: "Deny", style: .danger, size: .compact) {
                        markCommandExplanationSeen()
                        onDeny()
                    }
                    .overlay(
                        RoundedRectangle(cornerRadius: VRadius.md)
                            .stroke(VColor.systemNegativeStrong, lineWidth: keyboardModel?.selectedAction == .dontAllow ? 2 : 0)
                    )
                }
            }

            // First-time educational banner for command confirmations
            if isCommandTool && !hasSeenCommandExplanation {
                commandExplanationBanner
            }

            // Show details accordion
            VStack(alignment: .leading, spacing: 0) {
                Button {
                    withAnimation(VAnimation.fast) {
                        showTechnicalDetails.toggle()
                    }
                } label: {
                    HStack(alignment: .firstTextBaseline, spacing: VSpacing.xxs) {
                        VIconView(.chevronRight, size: 9)
                            .foregroundColor(VColor.contentDefault)
                            .rotationEffect(.degrees(showTechnicalDetails ? 90 : 0))
                            .frame(width: 9, height: 9)
                        Text(showTechnicalDetails ? "Hide details" : "Show details")
                            .font(VFont.captionMedium)
                            .foregroundColor(VColor.contentDefault)
                    }
                    .offset(x: -1)
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
                .fill(VColor.surfaceOverlay)
                .overlay(
                    RoundedRectangle(cornerRadius: VRadius.md)
                        .stroke(VColor.borderBase, lineWidth: 0.5)
                )
        )
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
                .foregroundColor(VColor.contentSecondary)
                .frame(maxWidth: .infinity, alignment: .leading)
                .textSelection(.enabled)
        }
        .frame(maxHeight: maxHeight)
        .padding(VSpacing.sm)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(
            RoundedRectangle(cornerRadius: VRadius.sm)
                .fill(VColor.surfaceOverlay)
        )
    }

    // MARK: - Description Text

    @ViewBuilder
    private var descriptionText: some View {
        Text(confirmation.humanDescription)
            .font(VFont.caption)
            .foregroundColor(VColor.contentTertiary)
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
                        .foregroundColor(VColor.contentTertiary)
                    VIconView(showDiff ? .chevronUp : .chevronDown, size: 8)
                        .foregroundColor(VColor.contentTertiary)
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
                        .foregroundColor(VColor.contentTertiary)

                    codePreviewBlock(diffBody, maxHeight: 260)
                }
                .textSelection(.enabled)
                .transition(.opacity.combined(with: .move(edge: .top)))
            }
        }
    }

    // MARK: - Button Row

    private var topLevelActions: [ToolConfirmationKeyboardModel.Action] {
        var actions: [ToolConfirmationKeyboardModel.Action] = []
        switch effectivePrimaryAction {
        case "allow_10m": actions.append(.allow10m)
        case "allow_conversation": actions.append(.allowConversation)
        default: actions.append(.allowOnce)
        }
        actions.append(.dontAllow)
        return actions
    }

    // MARK: - Allow Split Button

    private var isPrimaryAllowKeyboardSelected: Bool {
        guard let selected = keyboardModel?.selectedAction else { return false }
        switch effectivePrimaryAction {
        case "allow_10m": return selected == .allow10m
        case "allow_conversation": return selected == .allowConversation
        default: return selected == .allowOnce
        }
    }

    /// The effective primary action, resolving the persisted preference against
    /// what this confirmation actually supports.
    private var effectivePrimaryAction: String {
        switch preferredAllowAction {
        case "allow_10m" where hasAllow10m: return "allow_10m"
        case "allow_conversation" where hasAllowConversation: return "allow_conversation"
        case "allow_once": return "allow_once"
        default:
            if hasAllow10m { return "allow_10m" }
            return "allow_once"
        }
    }

    private var primaryAllowLabel: String {
        switch effectivePrimaryAction {
        case "allow_10m": return "Allow for 10 minutes"
        case "allow_conversation": return "Allow for this conversation"
        default: return "Allow once"
        }
    }

    private func firePrimaryAllow() {
        markCommandExplanationSeen()
        switch effectivePrimaryAction {
        case "allow_10m":
            onTemporaryAllow?(confirmation.requestId, "allow_10m")
        case "allow_conversation":
            onTemporaryAllow?(confirmation.requestId, "allow_conversation")
        default:
            onAllow()
        }
    }

    @ViewBuilder
    private var allowSplitButton: some View {
        let primary = effectivePrimaryAction
        VSplitButton(label: primaryAllowLabel, style: .primary, size: .compact, action: {
            firePrimaryAllow()
        }) {
            if primary != "allow_once" {
                Button("Allow once") {
                    markCommandExplanationSeen()
                    preferredAllowAction = "allow_once"
                    onAllow()
                }
            }

            if hasAllow10m && primary != "allow_10m" {
                Button("Allow for 10 minutes") {
                    markCommandExplanationSeen()
                    preferredAllowAction = "allow_10m"
                    onTemporaryAllow?(confirmation.requestId, "allow_10m")
                }
            }

            if hasAllowConversation && primary != "allow_conversation" {
                Button("Allow for this conversation") {
                    markCommandExplanationSeen()
                    preferredAllowAction = "allow_conversation"
                    onTemporaryAllow?(confirmation.requestId, "allow_conversation")
                }
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
        case .allowConversation:
            onTemporaryAllow?(confirmation.requestId, "allow_conversation")
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

    /// Convenience wrapper that maps the legacy isPrimary/isDanger flags to a `VButton.Style`.
    @ViewBuilder
    private func confirmationButton(_ label: String, isPrimary: Bool, isDanger: Bool, isDangerOutline: Bool = false, isKeyboardSelected: Bool = false, action: @escaping () -> Void) -> some View {
        let style: VButton.Style = isDanger ? .danger : isDangerOutline ? .dangerOutline : isPrimary ? .primary : .outlined
        VButton(label: label, style: style, size: .compact, action: action)
            .overlay(
                RoundedRectangle(cornerRadius: VRadius.md)
                    .stroke(VColor.primaryBase, lineWidth: isKeyboardSelected ? 2 : 0)
            )
            .accessibilityLabel(label)
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
                                .foregroundColor(VColor.contentTertiary)
                        }
                        .buttonStyle(.plain)

                        Text("Choose scope")
                            .font(VFont.captionMedium)
                            .foregroundColor(VColor.contentTertiary)
                    }
                    .padding(.horizontal, VSpacing.sm)
                    .padding(.vertical, VSpacing.xs)

                    Divider()
                        .background(VColor.borderBase)

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
                                .background(VColor.borderBase)
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
                                .background(VColor.borderBase)
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
                .foregroundColor(VColor.contentTertiary)
                .padding(.horizontal, VSpacing.sm)
                .padding(.vertical, VSpacing.xs)

            Divider()
                .background(VColor.borderBase)

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
                        .background(VColor.borderBase)
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
                    .foregroundColor(VColor.contentDefault)
                if !subtitle.isEmpty {
                    Text(subtitle)
                        .font(VFont.caption)
                        .foregroundColor(VColor.contentTertiary)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.vertical, VSpacing.sm)
            .padding(.horizontal, VSpacing.sm)
            .background(
                RoundedRectangle(cornerRadius: VRadius.sm)
                    .fill(isHovered || isKeyboardSelected ? VColor.borderBase.opacity(0.5) : .clear)
            )
            .overlay(
                RoundedRectangle(cornerRadius: VRadius.sm)
                    .stroke(isKeyboardSelected ? VColor.primaryBase : .clear, lineWidth: 2)
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
                .foregroundColor(VColor.contentDefault)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.vertical, VSpacing.sm)
                .padding(.horizontal, VSpacing.sm)
                .background(
                    RoundedRectangle(cornerRadius: VRadius.sm)
                        .fill(isHovered || isKeyboardSelected ? VColor.borderBase.opacity(0.5) : .clear)
                )
                .overlay(
                    RoundedRectangle(cornerRadius: VRadius.sm)
                        .stroke(isKeyboardSelected ? VColor.primaryBase : .clear, lineWidth: 2)
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
#endif
