import SwiftUI

/// A clickable pill that displays an optional icon + keyboard shortcut hint (e.g. "⌘K", "🎤 fn").
public struct VShortcutTag: View {
    public let text: String
    public var icon: String? = nil
    public var action: (() -> Void)? = nil

    @State private var isHovered = false

    private let tagColor = Color(hex: 0xA1A096)
    private let borderColor = Color(hex: 0xE8E6DA)

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
                .font(VFont.caption)
        }
        .foregroundColor(tagColor)
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

#Preview("VShortcutTag") {
    ZStack {
        VColor.background.ignoresSafeArea()
        HStack(spacing: 12) {
            VShortcutTag("\u{2318}K")
            VShortcutTag("fn", icon: VIcon.mic.rawValue)
            VShortcutTag("\u{2318}G")
        }
        .padding()
    }
    .frame(width: 400, height: 80)
}
