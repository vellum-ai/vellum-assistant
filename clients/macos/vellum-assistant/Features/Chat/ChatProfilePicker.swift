import SwiftUI
import VellumAssistantShared

/// Bundle of the per-conversation inference-profile state and the persistence
/// callback the composer threads through to ``ChatProfilePicker``. Mirrors the
/// `ConversationHostAccessControlConfiguration` pattern so a single optional
/// parameter on ``ComposerView`` / ``ComposerSection`` toggles the pill.
struct ChatProfilePickerConfiguration {
    /// The current per-conversation inference-profile override. `nil` means
    /// the conversation inherits `activeProfile`.
    let current: String?

    /// Profiles available to pick from — typically `SettingsStore.profiles`.
    let profiles: [InferenceProfile]

    /// The workspace `llm.activeProfile`. Rendered in the pill label when
    /// `current` is `nil`.
    let activeProfile: String

    /// Persists a selection. Passing `nil` clears the override so the
    /// conversation falls back to `activeProfile`.
    let onSelect: (String?) -> Void
}

/// A compact pill button in the composer action bar that lets the user pick a
/// per-conversation inference profile override. Opens a dropdown with every
/// profile defined in `SettingsStore.profiles`, plus a "Reset to default"
/// item that clears the override and falls back to `llm.activeProfile`.
///
/// State ownership: the pill is stateless. The label is derived from the
/// `current` override plus `activeProfile`; selection is forwarded straight to
/// `ConversationManager.setConversationInferenceProfile(id:profile:)` which
/// updates the local conversation model and persists to the daemon.
@MainActor
struct ChatProfilePicker: View {
    /// The conversation whose override is being edited. `nil` disables the
    /// pill (e.g. for not-yet-persisted draft conversations).
    let conversationId: UUID?

    /// The current per-conversation inference-profile override. `nil` means
    /// the conversation inherits `activeProfile`.
    let current: String?

    /// Profiles available to pick from — typically `SettingsStore.profiles`.
    let profiles: [InferenceProfile]

    /// The workspace `llm.activeProfile`. Surfaced in the pill label when
    /// `current` is `nil` so the user can see which profile the conversation
    /// will inherit.
    let activeProfile: String

    /// Persists a selection. Passing `nil` clears the override so the
    /// conversation falls back to `activeProfile`.
    let onSelect: (String?) -> Void

    #if os(macOS)
    @State private var isMenuOpen = false
    @State private var activePanel: VMenuPanel?
    @State private var triggerFrame: CGRect = .zero
    #endif

    private let composerActionButtonSize: CGFloat = 32

    /// Pill label: the override profile when set, otherwise
    /// "Default (`<activeProfile>`)". Internal so tests can assert on it
    /// without spinning up a SwiftUI host.
    static func label(current: String?, activeProfile: String) -> String {
        if let current { return current }
        return "Default (\(activeProfile))"
    }

    var body: some View {
        #if os(macOS)
        Button {
            if isMenuOpen {
                activePanel?.close()
                activePanel = nil
                isMenuOpen = false
            } else {
                showMenu()
            }
        } label: {
            HStack(spacing: 4) {
                VIconView(.sparkles, size: 14)
                    .foregroundStyle(VColor.contentSecondary)
                Text(Self.label(current: current, activeProfile: activeProfile))
                    .font(VFont.labelDefault)
                    .foregroundStyle(VColor.contentSecondary)
                    .lineLimit(1)
                VIconView(.chevronDown, size: 10)
                    .foregroundStyle(VColor.contentTertiary)
            }
            .frame(height: composerActionButtonSize)
            .padding(.horizontal, VSpacing.xs)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .disabled(conversationId == nil)
        .vTooltip("Inference profile for this conversation")
        .accessibilityLabel("Inference profile")
        .accessibilityValue(Self.label(current: current, activeProfile: activeProfile))
        .overlay {
            GeometryReader { geo in
                Color.clear
                    .onAppear { triggerFrame = geo.frame(in: .global) }
                    .onChange(of: geo.frame(in: .global)) { _, newFrame in
                        triggerFrame = newFrame
                    }
            }
        }
        #endif
    }

    // MARK: - Menu

    #if os(macOS)
    private func showMenu() {
        guard !isMenuOpen, conversationId != nil else { return }
        isMenuOpen = true

        NSApp.keyWindow?.makeFirstResponder(nil)

        guard let window = NSApp.keyWindow ?? NSApp.windows.first(where: { $0.isVisible }) else {
            isMenuOpen = false
            return
        }

        let triggerInWindow = CGPoint(x: triggerFrame.minX, y: triggerFrame.maxY)
        let screenPoint = window.convertPoint(toScreen: NSPoint(
            x: triggerInWindow.x,
            y: window.frame.height - triggerInWindow.y
        ))

        let triggerScreenOrigin = window.convertPoint(toScreen: NSPoint(
            x: triggerFrame.minX,
            y: window.frame.height - triggerFrame.maxY
        ))
        let triggerScreenRect = CGRect(
            origin: triggerScreenOrigin,
            size: CGSize(width: triggerFrame.width, height: triggerFrame.height)
        )

        let appearance = window.effectiveAppearance
        activePanel = VMenuPanel.show(
            at: screenPoint,
            sourceWindow: window,
            sourceAppearance: appearance,
            excludeRect: triggerScreenRect
        ) {
            VMenu(width: 240) {
                ForEach(profiles) { profile in
                    VMenuItem(
                        icon: VIcon.sparkles.rawValue,
                        label: profile.name,
                        isActive: current == profile.name,
                        size: .regular
                    ) {
                        onSelect(profile.name)
                    } trailing: {
                        VStack(alignment: .trailing, spacing: 2) {
                            if current == profile.name {
                                VIconView(.check, size: 12)
                                    .foregroundStyle(VColor.primaryBase)
                            }
                        }
                    }
                }
                VMenuItem(
                    icon: VIcon.rotateCcw.rawValue,
                    label: "Reset to default (\(activeProfile))",
                    isActive: current == nil,
                    size: .regular
                ) {
                    onSelect(nil)
                } trailing: {
                    VStack(alignment: .trailing, spacing: 2) {
                        if current == nil {
                            VIconView(.check, size: 12)
                                .foregroundStyle(VColor.primaryBase)
                        }
                    }
                }
            }
        } onDismiss: {
            isMenuOpen = false
            activePanel = nil
        }
    }
    #endif
}
