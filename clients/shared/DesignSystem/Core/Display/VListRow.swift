import SwiftUI

public struct VListRow<Content: View>: View {

    public enum Size {
        /// Default density — generous padding for standalone lists.
        case `default`
        /// Compact density — tighter padding matching sidebar row metrics.
        case compact
    }

    public var size: Size = .default
    public var isSelected: Bool = false
    public var onTap: (() -> Void)? = nil
    @ViewBuilder public let content: () -> Content

    @State private var isHovered = false

    public init(size: Size = .default, isSelected: Bool = false, onTap: (() -> Void)? = nil, @ViewBuilder content: @escaping () -> Content) {
        self.size = size
        self.isSelected = isSelected
        self.onTap = onTap
        self.content = content
    }

    public var body: some View {
        Group {
            if let onTap = onTap {
                Button(action: onTap) {
                    rowContent
                }
                .buttonStyle(.plain)
                .pointerCursor()
            } else {
                rowContent
            }
        }
    }

    private var verticalPadding: CGFloat {
        switch size {
        case .default: return VSpacing.sm
        case .compact: return VSpacing.xs
        }
    }

    private var leadingPadding: CGFloat {
        switch size {
        case .default: return VSpacing.lg
        case .compact: return VSpacing.xs
        }
    }

    private var trailingPadding: CGFloat {
        switch size {
        case .default: return VSpacing.lg
        case .compact: return VSpacing.sm
        }
    }

    private var cornerRadius: CGFloat {
        switch size {
        case .default: return VRadius.sm
        case .compact: return VRadius.md
        }
    }

    private var minRowHeight: CGFloat? {
        switch size {
        case .default: return nil
        case .compact: return 32
        }
    }

    private var rowContent: some View {
        content()
            .padding(.vertical, verticalPadding)
            .padding(.leading, leadingPadding)
            .padding(.trailing, trailingPadding)
            .frame(maxWidth: .infinity, alignment: .leading)
            .frame(minHeight: minRowHeight)
            .background(
                isSelected ? VColor.surfaceActive :
                isHovered ? VColor.surfaceBase :
                Color.clear
            )
            .animation(VAnimation.fast, value: isHovered)
            .clipShape(RoundedRectangle(cornerRadius: cornerRadius))
            .contentShape(Rectangle())
            .onHover { hovering in
                isHovered = hovering
            }
    }
}

