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
    @State private var showTechnicalDetails = false
    @State private var useCompactConfirmationLayout = false
    @State private var keyboardModel: ToolConfirmationKeyboardModel?
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

    // MARK: - Tool Permission (pending)

    @ViewBuilder
    private var commandExplanationBanner: some View {
        HStack(alignment: .top, spacing: VSpacing.sm) {
            VIconView(.info, size: 14)
                .foregroundStyle(VColor.primaryBase)
                .padding(.top, 1)

            VStack(alignment: .leading, spacing: VSpacing.xs) {
                Text("What is this?")
                    .font(VFont.labelDefault)
                    .foregroundStyle(VColor.contentDefault)

                Text("Sometimes your assistant needs to run commands on your computer to complete tasks \u{2014} like installing software, checking settings, or organizing files. You\u{2019}ll always be asked for permission first, and nothing runs without your approval.")
                    .font(VFont.labelDefault)
                    .foregroundStyle(VColor.contentSecondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .padding(VSpacing.sm)
        .background(
            RoundedRectangle(cornerRadius: VRadius.sm)
                .fill(VColor.primaryBase.opacity(0.08))
        )
    }

    @ViewBuilder
    private var pendingContent: some View {
        let actions = topLevelActions
        VStack(alignment: .leading, spacing: VSpacing.sm) {
            // Adaptive layout: horizontal when wide, vertical when narrow
            if useCompactConfirmationLayout {
                confirmationDescription
                HStack {
                    Spacer()
                    confirmationActions
                }
            } else {
                HStack(alignment: .top, spacing: VSpacing.sm) {
                    confirmationDescription
                    Spacer(minLength: VSpacing.md)
                    confirmationActions
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
                            .foregroundStyle(VColor.contentDefault)
                            .rotationEffect(.degrees(showTechnicalDetails ? 90 : 0))
                            .frame(width: 9, height: 9)
                        Text(showTechnicalDetails ? "Hide details" : "Show details")
                            .font(VFont.labelDefault)
                            .foregroundStyle(VColor.contentDefault)
                    }
                    .padding(.leading, -1)
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
                    .transition(.opacity)
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
        .textSelection(.disabled)
        .onGeometryChange(for: Bool.self) { proxy in
            proxy.size.width < 450
        } action: { isCompact in
            withAnimation(.none) {
                useCompactConfirmationLayout = isCompact
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
                .font(VFont.bodySmallDefault)
                .foregroundStyle(VColor.contentSecondary)
                .textSelection(.enabled)
        }
        .adaptiveScrollFrame(for: content, maxHeight: maxHeight, lineThreshold: Int(maxHeight / 16))
        .padding(VSpacing.sm)
        .background(
            RoundedRectangle(cornerRadius: VRadius.sm)
                .fill(VColor.surfaceOverlay)
        )
    }

    // MARK: - Description Text

    @ViewBuilder
    private var descriptionText: some View {
        Text(confirmation.humanDescription)
            .font(VFont.labelDefault)
            .foregroundStyle(VColor.contentTertiary)
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
                        .foregroundStyle(VColor.contentTertiary)
                    VIconView(showDiff ? .chevronUp : .chevronDown, size: 8)
                        .foregroundStyle(VColor.contentTertiary)
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel(showDiff ? "Hide diff" : "View diff")

            if showDiff, let diffInfo = confirmation.diff {
                let computedDiff = confirmation.unifiedDiffPreview ?? ""
                VStack(alignment: .leading, spacing: VSpacing.xs) {
                    Text(diffInfo.filePath)
                        .font(VFont.bodySmallDefault)
                        .foregroundStyle(VColor.contentTertiary)

                    if computedDiff.isEmpty {
                        codePreviewBlock(diffInfo.newContent, maxHeight: 260)
                    } else {
                        VDiffView(computedDiff, maxHeight: 260)
                            .padding(VSpacing.sm)
                            .background(
                                RoundedRectangle(cornerRadius: VRadius.sm)
                                    .fill(VColor.surfaceOverlay)
                            )
                    }
                }
                .textSelection(.enabled)
                .transition(.opacity)
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
            return "allow_once"
        }
    }

    private var primaryAllowLabel: String {
        if confirmation.isConversationHostAccessPrompt {
            return "Enable computer access"
        }

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

    private var hasAlwaysAllow: Bool {
        hasRuleOptions && confirmation.persistentDecisionsAllowed
    }

    private var hasSecondaryAllowOptions: Bool {
        let primary = effectivePrimaryAction
        return (primary != "allow_once") ||
               (hasAllow10m && primary != "allow_10m") ||
               (hasAllowConversation && primary != "allow_conversation") ||
               hasAlwaysAllow
    }

    private var confirmationDescription: some View {
        Text(confirmation.humanDescription)
            .font(VFont.bodyMediumEmphasised)
            .foregroundStyle(VColor.contentDefault)
            .fixedSize(horizontal: false, vertical: true)
    }

    private var confirmationActions: some View {
        HStack(spacing: VSpacing.sm) {
            allowSplitButton
                .overlay(
                    RoundedRectangle(cornerRadius: VRadius.md)
                        .strokeBorder(VColor.primaryBase, lineWidth: isPrimaryAllowKeyboardSelected ? 2 : 0)
                        .allowsHitTesting(false)
                )

            VButton(label: "Deny", style: .danger, size: .compact) {
                markCommandExplanationSeen()
                onDeny()
            }
            .overlay(
                RoundedRectangle(cornerRadius: VRadius.md)
                    .strokeBorder(VColor.systemNegativeStrong, lineWidth: keyboardModel?.selectedAction == .dontAllow ? 2 : 0)
                    .allowsHitTesting(false)
            )
        }
    }

    @ViewBuilder
    private var allowSplitButton: some View {
        let primary = effectivePrimaryAction
        if hasSecondaryAllowOptions {
            VSplitButton(label: primaryAllowLabel, style: .primary, size: .compact, action: {
                firePrimaryAllow()
            }) {
                // "This action" — scoped to this specific invocation or pattern
                Section("This action") {
                    if primary != "allow_once" {
                        Button("Allow once") {
                            markCommandExplanationSeen()
                            preferredAllowAction = "allow_once"
                            onAllow()
                        }
                    }

                    if hasAlwaysAllow {
                        alwaysAllowMenuItems
                    }
                }

                // "All actions" — blanket approval for a duration
                if hasAllow10m || hasAllowConversation {
                    Section("All actions") {
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

                // Show hint when preference-changing options are available.
                // Hidden when "Always allow" is the only secondary option
                // since it creates a persistent rule, not a default preference.
                if hasAllow10m || hasAllowConversation || primary != "allow_once" {
                    Section {
                        Text("Sets your default for this action")
                    }
                }
            }
        } else {
            VButton(label: primaryAllowLabel, style: .primary, size: .compact) {
                firePrimaryAllow()
            }
        }
    }

    private var alwaysAllowPatternLabel: String {
        let tool = confirmation.toolName
        if tool == "bash" || tool == "host_bash" { return "Command" }
        if tool.contains("file") { return "File" }
        if tool == "web_fetch" || tool == "web_search" { return "URL" }
        return "Pattern"
    }

    @ViewBuilder
    private var alwaysAllowMenuItems: some View {
        let options = confirmation.allowlistOptions
        let scopes = confirmation.scopeOptions

        if options.count > 1 {
            // Multiple patterns — show each, with scope submenus if needed
            Menu("Always allow") {
                Section(alwaysAllowPatternLabel) {
                    ForEach(Array(options.enumerated()), id: \.element.pattern) { _, option in
                        if scopes.isEmpty {
                            Button(option.label) {
                                markCommandExplanationSeen()
    
                                onAlwaysAllow(confirmation.requestId, option.pattern, "everywhere", alwaysAllowDecision)
                            }
                        } else {
                            Menu(option.label) {
                                Section("Scope") {
                                    ForEach(Array(scopes.enumerated()), id: \.element.scope) { _, scopeOption in
                                        Button(scopeOption.label) {
                                            markCommandExplanationSeen()
                
                                            onAlwaysAllow(confirmation.requestId, option.pattern, scopeOption.scope, alwaysAllowDecision)
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
            }
        } else if let option = options.first {
            // Single pattern
            if scopes.isEmpty {
                Button("Always allow") {
                    markCommandExplanationSeen()
                    if option.pattern.isEmpty {
                        onAllow()
                    } else {
                        onAlwaysAllow(confirmation.requestId, option.pattern, "everywhere", alwaysAllowDecision)
                    }
                }
            } else {
                // Single pattern with scope choice
                Menu("Always allow") {
                    Section("Scope") {
                        ForEach(Array(scopes.enumerated()), id: \.element.scope) { _, scopeOption in
                            Button(scopeOption.label) {
                                markCommandExplanationSeen()
    
                                onAlwaysAllow(confirmation.requestId, option.pattern, scopeOption.scope, alwaysAllowDecision)
                            }
                        }
                    }
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
            let pattern = confirmation.allowlistOptions.first?.pattern ?? ""
            let scope = confirmation.scopeOptions.first?.scope ?? "everywhere"
            if pattern.isEmpty {
                onAllow()
            } else {
                onAlwaysAllow(confirmation.requestId, pattern, scope, alwaysAllowDecision)
            }
        case .dontAllow:
            onDeny()
        }
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
