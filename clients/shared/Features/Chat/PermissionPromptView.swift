import SwiftUI
#if os(macOS)
import AppKit
#endif

/// Standalone permission prompt view.
/// Provides a simplified Allow/Deny interface with inline risk badge,
/// risk reason text, and keyboard support.
public struct PermissionPromptView: View {
    public let confirmation: ToolConfirmationData
    public let isKeyboardActive: Bool
    public let onAllow: () -> Void
    public let onDeny: () -> Void
    public let onAlwaysAllow: (String, String, String, String) -> Void
    /// Called when the user taps "Allow & Create Rule". The parent is responsible
    /// for calling the suggest API and presenting the rule editor modal.
    public let onAllowAndSuggestRule: (() -> Void)?

    @State private var showTechnicalDetails = false
    @State private var keyboardModel: ToolConfirmationKeyboardModel?
    #if os(macOS)
    @State private var keyMonitor: Any?
    #endif

    public init(
        confirmation: ToolConfirmationData,
        isKeyboardActive: Bool,
        onAllow: @escaping () -> Void,
        onDeny: @escaping () -> Void,
        onAlwaysAllow: @escaping (String, String, String, String) -> Void,
        onAllowAndSuggestRule: (() -> Void)? = nil
    ) {
        self.confirmation = confirmation
        self.isKeyboardActive = isKeyboardActive
        self.onAllow = onAllow
        self.onDeny = onDeny
        self.onAlwaysAllow = onAlwaysAllow
        self.onAllowAndSuggestRule = onAllowAndSuggestRule
    }

    private var v3TopLevelActions: [ToolConfirmationKeyboardModel.Action] {
        [.allowOnce, .dontAllow]
    }

    /// The full input preview for the inline display (all key-value pairs).
    private var inlinePreviewText: String? {
        let preview = confirmation.fullInputPreview
        return preview.isEmpty ? nil : preview
    }

    public var body: some View {
        VStack(alignment: .leading, spacing: VSpacing.sm) {
            // 1. Prompt line with risk badge
            v3ConfirmationDescription

            // 2. Actions: Allow + Deny
            HStack {
                Spacer()
                v3ConfirmationActions
            }

            // 3. Show details disclosure
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
        .onAppear {
            if isKeyboardActive {
                #if os(macOS)
                installKeyMonitor(actions: v3TopLevelActions)
                #else
                keyboardModel = ToolConfirmationKeyboardModel(actions: v3TopLevelActions)
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
                installKeyMonitor(actions: v3TopLevelActions)
                #else
                keyboardModel = ToolConfirmationKeyboardModel(actions: v3TopLevelActions)
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

    // MARK: - v3 Prompt Components

    /// v3 description: tool name with inline risk badge and optional risk reason.
    @ViewBuilder
    private var v3ConfirmationDescription: some View {
        VStack(alignment: .leading, spacing: VSpacing.xs) {
            HStack(spacing: VSpacing.sm) {
                Text(confirmation.humanDescription)
                    .font(VFont.bodyMediumEmphasised)
                    .foregroundStyle(VColor.contentDefault)
                    .fixedSize(horizontal: false, vertical: true)
                v3RiskBadge
            }
            if let reason = confirmation.riskReason, !reason.isEmpty {
                Text(reason)
                    .font(VFont.labelDefault)
                    .foregroundStyle(VColor.contentTertiary)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
    }

    /// Inline risk level badge for v3 prompts.
    @ViewBuilder
    private var v3RiskBadge: some View {
        let level = confirmation.riskLevel
        let label = level.isEmpty ? "Unknown" : level.prefix(1).uppercased() + level.dropFirst()
        Text(label)
            .font(VFont.labelDefault)
            .foregroundStyle(v3RiskBadgeTextColor)
            .padding(EdgeInsets(top: 2, leading: 6, bottom: 2, trailing: 6))
            .background(v3RiskBadgeBackgroundColor)
            .clipShape(Capsule())
    }

    private var v3RiskBadgeBackgroundColor: Color {
        switch confirmation.riskLevel.lowercased() {
        case "low": VColor.systemPositiveStrong
        case "medium": VColor.systemMidStrong
        case "high": VColor.systemNegativeStrong
        default: VColor.contentSecondary
        }
    }

    private var v3RiskBadgeTextColor: Color {
        switch confirmation.riskLevel.lowercased() {
        case "medium": VColor.auxBlack
        default: VColor.auxWhite
        }
    }

    /// v3 simplified actions: Allow (with optional split for suggest) + Deny.
    private var v3ConfirmationActions: some View {
        HStack(spacing: VSpacing.sm) {
            if onAllowAndSuggestRule != nil {
                VSplitButton(label: "Allow", style: .primary, size: .compact, action: {
                    if let option = confirmation.allowlistOptions.first, !option.pattern.isEmpty {
                        let scope = confirmation.scopeOptions.first?.scope ?? "everywhere"
                        onAlwaysAllow(confirmation.requestId, option.pattern, scope, "allow")
                    } else {
                        onAllow()
                    }
                }) {
                    Button("Allow & Create Rule") {
                        onAllowAndSuggestRule?()
                    }
                }
                .overlay(
                    RoundedRectangle(cornerRadius: VRadius.md)
                        .strokeBorder(VColor.primaryBase, lineWidth: keyboardModel?.selectedAction == .allowOnce ? 2 : 0)
                        .allowsHitTesting(false)
                )
            } else {
                VButton(label: "Allow", style: .primary, size: .compact) {
                    if let option = confirmation.allowlistOptions.first, !option.pattern.isEmpty {
                        let scope = confirmation.scopeOptions.first?.scope ?? "everywhere"
                        onAlwaysAllow(confirmation.requestId, option.pattern, scope, "allow")
                    } else {
                        onAllow()
                    }
                }
                .overlay(
                    RoundedRectangle(cornerRadius: VRadius.md)
                        .strokeBorder(VColor.primaryBase, lineWidth: keyboardModel?.selectedAction == .allowOnce ? 2 : 0)
                        .allowsHitTesting(false)
                )
            }

            VButton(label: "Deny", style: .danger, size: .compact) {
                onDeny()
            }
            .overlay(
                RoundedRectangle(cornerRadius: VRadius.md)
                    .strokeBorder(VColor.systemNegativeStrong, lineWidth: keyboardModel?.selectedAction == .dontAllow ? 2 : 0)
                    .allowsHitTesting(false)
            )
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

    /// Trigger the callback for a given top-level action.
    private func activateAction(_ action: ToolConfirmationKeyboardModel.Action) {
        switch action {
        case .allowOnce:
            // v3: route through the allowlist pattern path if available
            if let option = confirmation.allowlistOptions.first, !option.pattern.isEmpty {
                let scope = confirmation.scopeOptions.first?.scope ?? "everywhere"
                onAlwaysAllow(confirmation.requestId, option.pattern, scope, "allow")
            } else {
                onAllow()
            }
        case .dontAllow:
            onDeny()
        default:
            break
        }
    }
}
