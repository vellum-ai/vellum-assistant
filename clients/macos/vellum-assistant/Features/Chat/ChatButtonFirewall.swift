import SwiftUI
import VellumAssistantShared

// MARK: - Color Role

/// Equatable token-to-color mapping for chat-only button tones.
/// Using an enum instead of raw `Color` makes the intent explicit at call sites
/// and avoids comparing resolved color values that might differ across appearances.
enum ChatButtonColorRole: Equatable, Hashable {
    case contentTertiary
    case systemPositiveStrong
    case systemNegativeStrong
    case primaryBase

    var resolved: Color {
        switch self {
        case .contentTertiary: VColor.contentTertiary
        case .systemPositiveStrong: VColor.systemPositiveStrong
        case .systemNegativeStrong: VColor.systemNegativeStrong
        case .primaryBase: VColor.primaryBase
        }
    }
}

// MARK: - Config

/// Equatable config surface for a chat button's render identity.
/// Captures every VButton property that affects visual output in the chat
/// message-list path. Closures are intentionally excluded so that SwiftUI
/// can skip body re-evaluation when only the closure reference changes.
///
/// When a closure captures mutable state (e.g. streaming `copyText`),
/// set `closureIdentity` to a value that changes alongside the captured
/// state so the firewall re-evaluates and picks up the fresh closure.
struct ChatButtonConfig: Equatable {
    let label: String
    let iconOnly: String?
    let style: VButton.Style
    let size: VButton.Size
    let iconSize: CGFloat?
    let iconColorRole: ChatButtonColorRole?
    let tooltip: String?
    let isDisabled: Bool
    /// Opaque identity for the closure's captured state. When this changes,
    /// the firewall treats the button as different, forcing a body re-evaluation
    /// that picks up the new closure. Defaults to 0 (stable).
    var closureIdentity: Int = 0
}

// MARK: - Equatable Button

/// Chat-local `View, Equatable` wrapper that renders a `VButton` from
/// `ChatButtonConfig` and compares only render-relevant config, ignoring
/// closure identity. This prevents unnecessary VButton body evaluations
/// when unrelated parent views invalidate.
struct ChatEquatableButton: View, Equatable {
    let config: ChatButtonConfig
    let action: () -> Void

    static func == (lhs: ChatEquatableButton, rhs: ChatEquatableButton) -> Bool {
        lhs.config == rhs.config
    }

    var body: some View {
        VButton(
            label: config.label,
            iconOnly: config.iconOnly,
            style: config.style,
            size: config.size,
            isDisabled: config.isDisabled,
            iconSize: config.iconSize,
            tooltip: config.tooltip,
            iconColor: config.iconColorRole?.resolved,
            action: action
        )
    }
}

// MARK: - Convenience Initializers

extension ChatEquatableButton {
    /// Icon-only button used by the overflow menu (copy, TTS, fork, inspect).
    init(
        label: String,
        iconOnly: String,
        iconColorRole: ChatButtonColorRole = .contentTertiary,
        iconSize: CGFloat = 24,
        action: @escaping () -> Void
    ) {
        self.config = ChatButtonConfig(
            label: label,
            iconOnly: iconOnly,
            style: .ghost,
            size: .regular,
            iconSize: iconSize,
            iconColorRole: iconColorRole,
            tooltip: nil,
            isDisabled: false
        )
        self.action = action
    }

    /// Inline text button used by sendFailedIndicator retry.
    /// Uses `textLabel` to disambiguate from the icon-only initializer.
    init(
        textLabel: String,
        style: VButton.Style,
        size: VButton.Size,
        action: @escaping () -> Void
    ) {
        self.config = ChatButtonConfig(
            label: textLabel,
            iconOnly: nil,
            style: style,
            size: size,
            iconSize: nil,
            iconColorRole: nil,
            tooltip: nil,
            isDisabled: false
        )
        self.action = action
    }
}
