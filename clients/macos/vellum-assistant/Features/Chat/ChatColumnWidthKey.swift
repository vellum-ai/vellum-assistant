import SwiftUI
import VellumAssistantShared

// MARK: - Responsive Column Layout

/// Computes the responsive chat column max-width from the measured container width.
/// The column fills ~82% of the available width, clamped to [728, 960] so it never
/// gets too narrow (unreadable) or too wide (wasteful margins disappear entirely).
enum ChatColumnLayout {
    static let minWidth: CGFloat = VSpacing.chatColumnMaxWidth // 728
    static let maxWidth: CGFloat = 960
    static let fillRatio: CGFloat = 0.82

    static func responsiveColumnWidth(for containerWidth: CGFloat) -> CGFloat {
        guard containerWidth > 0 else { return minWidth }
        let computed = containerWidth * fillRatio
        return min(max(computed, minWidth), maxWidth)
    }
}

// MARK: - Environment Key

/// Injects the responsive chat column width through the SwiftUI environment.
/// Default value falls back to the static `VSpacing.chatColumnMaxWidth` (728pt)
/// so views that render outside the active conversation path (e.g. empty-state)
/// keep their existing behavior.
private struct ChatColumnWidthKey: EnvironmentKey {
    static let defaultValue: CGFloat = VSpacing.chatColumnMaxWidth
}

extension EnvironmentValues {
    var chatColumnWidth: CGFloat {
        get { self[ChatColumnWidthKey.self] }
        set { self[ChatColumnWidthKey.self] = newValue }
    }
}
