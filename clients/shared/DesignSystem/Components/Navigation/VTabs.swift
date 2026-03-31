import SwiftUI

public enum VTabsStyle {
    case underline
    case pill
}

public enum VTabsSize {
    case regular
    case compact
}

public struct VTabs<SelectionValue: Hashable>: View {
    public let items: [(label: String, icon: String?, tag: SelectionValue)]
    @Binding public var selection: SelectionValue
    public let style: VTabsStyle
    public let size: VTabsSize

    public init(items: [(label: String, icon: String?, tag: SelectionValue)], selection: Binding<SelectionValue>, style: VTabsStyle = .underline, size: VTabsSize = .regular) {
        self.items = items
        self._selection = selection
        self.style = style
        self.size = size
    }

    /// Convenience init without icons.
    public init(items: [(label: String, tag: SelectionValue)], selection: Binding<SelectionValue>, style: VTabsStyle = .underline, size: VTabsSize = .regular) {
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
                    VStack(spacing: 0) {
                        Text(item.label)
                            .font(VFont.bodyMediumDefault)
                            .foregroundStyle(selection == item.tag ? VColor.primaryActive : VColor.contentSecondary)
                            .padding(.horizontal, 10)
                            .padding(.vertical, 7)

                        Rectangle()
                            .fill(selection == item.tag ? VColor.borderActive : .clear)
                            .frame(height: 2)
                    }
                    .fixedSize(horizontal: true, vertical: false)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .pointerCursor()
                .accessibilityLabel(item.label)
                .accessibilityAddTraits(selection == item.tag ? .isSelected : [])
            }
            Spacer(minLength: 0)
        }
        .background(alignment: .bottom) {
            Rectangle()
                .fill(VColor.borderDisabled)
                .frame(height: 2)
        }
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
            RoundedRectangle(cornerRadius: VRadius.md)
                .fill(VColor.surfaceBase)
        )
        .animation(VAnimation.fast, value: selection)
    }
}

// MARK: - Int convenience initializer

public extension VTabs where SelectionValue == Int {
    init(items: [String], selection: Binding<Int>, style: VTabsStyle = .underline, size: VTabsSize = .regular) {
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
    let size: VTabsSize
    let isSelected: Bool
    let action: () -> Void

    @State private var isHovered = false

    var body: some View {
        Button(action: action) {
            Group {
                if let icon {
                    VIconView(.resolve(icon), size: 12)
                        .foregroundStyle(VColor.contentDefault)
                } else {
                    Text(label)
                        .font(VFont.bodyMediumDefault)
                        .fixedSize()
                        .foregroundStyle(isSelected ? VColor.contentEmphasized : VColor.contentSecondary)
                }
            }
            .padding(.horizontal, icon != nil ? VSpacing.sm : 10)
            .frame(maxWidth: .infinity)
            .frame(height: 28)
            .background(
                RoundedRectangle(cornerRadius: VRadius.md)
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
