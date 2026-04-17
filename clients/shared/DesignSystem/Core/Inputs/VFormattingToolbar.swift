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

    public let actions: [Action]
    public let onAction: (Action) -> Void

    public init(
        actions: [Action] = [.bold, .italic, .underline, .alignLeft, .alignCenter, .alignRight, .link],
        onAction: @escaping (Action) -> Void
    ) {
        self.actions = actions
        self.onAction = onAction
    }

    public var body: some View {
        HStack(spacing: VSpacing.sm) {
            ForEach(actions, id: \.self) { action in
                VButton(
                    label: label(for: action),
                    iconOnly: iconName(for: action),
                    style: .ghost,
                    size: .pill
                ) {
                    onAction(action)
                }
            }
            Spacer(minLength: 0)
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
        case .alignLeft: return VIcon.textAlignLeft.rawValue
        case .alignCenter: return VIcon.textAlignCenter.rawValue
        case .alignRight: return VIcon.textAlignRight.rawValue
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
