import SwiftUI

/// Stateless horizontal row of icon-only formatting action buttons for rich-text
/// editors. The toolbar itself holds no state — callers own the current
/// selection/formatting state and react to the `onAction` callback to apply
/// changes to the underlying text model.
///
/// Use this instead of hand-rolling an `HStack` of `VButton(iconOnly:)` buttons
/// whenever you need a bold/italic/underline style bar — for example, an email
/// composer, notes editor, or docs surface.
public struct VFormattingToolbar: View {

    /// A superset of formatting actions the toolbar can advertise. Callers
    /// choose the subset they care about via `actions:` and receive an
    /// `Action` in the `onAction` callback when one is tapped.
    public enum Action: Hashable, Sendable {
        case bold
        case italic
        case underline
        case alignLeft
        case alignCenter
        case alignRight
        case link
        case unorderedList
        case orderedList
        case quote
    }

    /// Actions organized into visual groups. Each inner array is rendered
    /// as a tight cluster of buttons; between clusters a flexible spacer
    /// is inserted so the groups distribute across the available width
    /// (leading / middle / trailing for a 3-group toolbar, matching the
    /// Figma mock).
    public let groups: [[Action]]
    public let onAction: (Action) -> Void

    /// Default 3-group layout from the email composer mock
    /// (Figma `3496:72522`): text style, alignment, misc.
    public init(
        groups: [[Action]] = [
            [.bold, .italic, .underline],
            [.alignLeft, .alignCenter, .alignRight],
            [.link, .quote]
        ],
        onAction: @escaping (Action) -> Void
    ) {
        self.groups = groups
        self.onAction = onAction
    }

    /// Convenience for callers that want a single flat group of actions
    /// (e.g. a trimmed bold/italic/underline/link bar). Renders the
    /// actions as one cluster pushed to the leading edge.
    public init(
        actions: [Action],
        onAction: @escaping (Action) -> Void
    ) {
        self.init(groups: [actions], onAction: onAction)
    }

    public var body: some View {
        HStack(spacing: 0) {
            ForEach(Array(groups.enumerated()), id: \.offset) { idx, group in
                if idx > 0 {
                    Spacer(minLength: VSpacing.md)
                }
                HStack(spacing: VSpacing.xs) {
                    ForEach(group, id: \.self) { action in
                        VButton(
                            label: label(for: action),
                            iconOnly: iconName(for: action),
                            style: .ghost,
                            size: .pill
                        ) {
                            onAction(action)
                        }
                    }
                }
            }
            // When there's only one group, keep it pinned to the leading
            // edge — callers passing a flat `actions:` array expect the
            // original "left-aligned row" layout.
            if groups.count < 2 {
                Spacer(minLength: 0)
            }
        }
        .padding(.horizontal, VSpacing.sm)
        .padding(.vertical, VSpacing.xs)
    }

    // MARK: - Mapping

    private func iconName(for action: Action) -> String {
        switch action {
        case .bold: return VIcon.bold.rawValue
        case .italic: return VIcon.italic.rawValue
        case .underline: return VIcon.underline.rawValue
        case .alignLeft: return VIcon.textAlignStart.rawValue
        case .alignCenter: return VIcon.textAlignCenter.rawValue
        case .alignRight: return VIcon.textAlignEnd.rawValue
        case .link: return VIcon.link.rawValue
        case .unorderedList: return VIcon.list.rawValue
        case .orderedList: return VIcon.listOrdered.rawValue
        case .quote: return VIcon.quote.rawValue
        }
    }

    private func label(for action: Action) -> String {
        switch action {
        case .bold: return "Bold"
        case .italic: return "Italic"
        case .underline: return "Underline"
        case .alignLeft: return "Align left"
        case .alignCenter: return "Align center"
        case .alignRight: return "Align right"
        case .link: return "Insert link"
        case .unorderedList: return "Bulleted list"
        case .orderedList: return "Numbered list"
        case .quote: return "Block quote"
        }
    }
}
