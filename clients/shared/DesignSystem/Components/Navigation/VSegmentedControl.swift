import SwiftUI

public enum VSegmentedControlStyle {
    case underline
    case pill
}

public enum VSegmentedControlSize {
    case regular
    case compact
}

public struct VSegmentedControl<SelectionValue: Hashable>: View {
    public let items: [(label: String, icon: String?, tag: SelectionValue)]
    @Binding public var selection: SelectionValue
    public let style: VSegmentedControlStyle
    public let size: VSegmentedControlSize

    public init(items: [(label: String, icon: String?, tag: SelectionValue)], selection: Binding<SelectionValue>, style: VSegmentedControlStyle = .underline, size: VSegmentedControlSize = .regular) {
        self.items = items
        self._selection = selection
        self.style = style
        self.size = size
    }

    /// Convenience init without icons.
    public init(items: [(label: String, tag: SelectionValue)], selection: Binding<SelectionValue>, style: VSegmentedControlStyle = .underline, size: VSegmentedControlSize = .regular) {
        self.items = items.map { (label: $0.label, icon: nil, tag: $0.tag) }
        self._selection = selection
        self.style = style
        self.size = size
    }

    public var body: some View {
        switch style {
        case .underline:
            underlineBody
        case .pill:
            pillBody
        }
    }

    // MARK: - Underline Style

    private var underlineBody: some View {
        HStack(spacing: 0) {
            ForEach(items.indices, id: \.self) { index in
                let item = items[index]
                Button(action: { selection = item.tag }) {
                    VStack(spacing: VSpacing.xs) {
                        Text(item.label)
                            .font(VFont.captionMedium)
                            .foregroundColor(selection == item.tag ? VColor.contentDefault : VColor.contentTertiary)
                            .padding(.horizontal, VSpacing.xl)
                            .padding(.vertical, VSpacing.xs)

                        Rectangle()
                            .fill(selection == item.tag ? VColor.primaryBase : .clear)
                            .frame(height: 2)
                    }
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .pointerCursor()
                .accessibilityLabel(item.label)
                .accessibilityAddTraits(selection == item.tag ? .isSelected : [])
            }
            Spacer()
        }
        .padding(.horizontal, VSpacing.sm)
    }

    // MARK: - Pill Style

    private var pillBody: some View {
        HStack(spacing: 2) {
            ForEach(items.indices, id: \.self) { index in
                let item = items[index]
                PillSegment(
                    label: item.label,
                    icon: item.icon,
                    size: size,
                    isSelected: selection == item.tag,
                    action: { selection = item.tag }
                )
            }
        }
        .padding(2)
        .background(
            RoundedRectangle(cornerRadius: size == .compact ? VRadius.sm + 1 : VRadius.md)
                .fill(VColor.surfaceActive)
        )
        .animation(VAnimation.fast, value: selection)
    }
}

// MARK: - Int convenience initializer

public extension VSegmentedControl where SelectionValue == Int {
    init(items: [String], selection: Binding<Int>, style: VSegmentedControlStyle = .underline, size: VSegmentedControlSize = .regular) {
        self.init(
            items: items.enumerated().map { (label: $0.element, icon: nil as String?, tag: $0.offset) },
            selection: selection,
            style: style,
            size: size
        )
    }
}

// MARK: - Pill Segment

private struct PillSegment: View {
    let label: String
    var icon: String? = nil
    let size: VSegmentedControlSize
    let isSelected: Bool
    let action: () -> Void

    @State private var isHovered = false

    var body: some View {
        Button(action: action) {
            Group {
                if let icon {
                    VIconView(.resolve(icon), size: size == .compact ? 10 : 12)
                        .foregroundColor(isSelected ? VColor.contentDefault : VColor.contentTertiary)
                } else {
                    Text(label)
                        .font(size == .compact ? VFont.captionMedium : VFont.body)
                        .fixedSize()
                        .foregroundColor(isSelected ? selectedTextColor : VColor.contentSecondary)
                }
            }
            .padding(.horizontal, icon != nil ? VSpacing.sm : (size == .compact ? VSpacing.sm : VSpacing.lg))
            .frame(maxWidth: .infinity)
            .frame(height: size == .compact ? 24 : 32)
            .background(
                RoundedRectangle(cornerRadius: size == .compact ? VRadius.sm : VRadius.md - 1)
                    .fill(segmentBackground)
                    .shadow(color: isSelected ? VColor.auxBlack.opacity(0.08) : .clear, radius: 2, x: 0, y: 1)
            )
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .onHover { isHovered = $0 }
        .pointerCursor()
        .accessibilityLabel(label)
        .accessibilityAddTraits(isSelected ? .isSelected : [])
    }

    private var selectedTextColor: Color {
        VColor.contentDefault
    }

    private var segmentBackground: Color {
        if isSelected {
            return VColor.surfaceLift
        } else if isHovered {
            return VColor.surfaceActive
        } else {
            return .clear
        }
    }
}
