import SwiftUI

/// A clickable pill that displays an optional icon + keyboard shortcut hint (e.g. "⌘K", "🎤 fn").
public struct VShortcutTag: View {
    public let text: String
    public var icon: String? = nil
    public var action: (() -> Void)? = nil

    @State private var isHovered = false

    private let tagColor = VColor.contentSecondary
    private let borderColor = VColor.borderBase

    public init(_ text: String, icon: String? = nil, action: (() -> Void)? = nil) {
        self.text = text
        self.icon = icon
        self.action = action
    }

    private var tagContent: some View {
        HStack(spacing: VSpacing.xs) {
            if let icon {
                VIconView(.resolve(icon), size: 11)
            }
            Text(text)
                .font(VFont.labelDefault)
        }
        .foregroundStyle(tagColor)
        .padding(.horizontal, VSpacing.sm)
        .padding(.vertical, VSpacing.xs)
        .background(
            Capsule()
                .strokeBorder(isHovered ? tagColor.opacity(0.5) : borderColor, lineWidth: 1)
        )
    }

    public var body: some View {
        if let action {
            Button(action: action) {
                tagContent
            }
            .buttonStyle(.plain)
            .onHover { hovering in
                isHovered = hovering
            }
            .pointerCursor()
            .accessibilityLabel(text)
        } else {
            tagContent
                .allowsHitTesting(false)
                .accessibilityLabel(text)
        }
    }
}

