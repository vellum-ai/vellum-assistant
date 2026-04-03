import SwiftUI

/// A segmented control with pill-style segments supporting text or icon content.
public struct VSegmentControl<SelectionValue: Hashable>: View {
    public let items: [(label: String, icon: String?, tag: SelectionValue)]
    @Binding public var selection: SelectionValue

    public init(items: [(label: String, icon: String?, tag: SelectionValue)], selection: Binding<SelectionValue>) {
        self.items = items
        self._selection = selection
    }

    /// Convenience init without icons.
    public init(items: [(label: String, tag: SelectionValue)], selection: Binding<SelectionValue>) {
        self.items = items.map { (label: $0.label, icon: nil, tag: $0.tag) }
        self._selection = selection
    }

    public var body: some View {
        HStack(spacing: 0) {
            ForEach(items.indices, id: \.self) { index in
                let item = items[index]
                Segment(
                    label: item.label,
                    icon: item.icon,
                    isSelected: selection == item.tag,
                    action: { selection = item.tag }
                )
            }
        }
        .padding(2)
        .background(
            RoundedRectangle(cornerRadius: VRadius.md)
                .fill(VColor.contentBackground)
        )
        .animation(VAnimation.fast, value: selection)
    }
}

// MARK: - Int convenience initializer

public extension VSegmentControl where SelectionValue == Int {
    init(items: [String], selection: Binding<Int>) {
        self.init(
            items: items.enumerated().map { (label: $0.element, icon: nil as String?, tag: $0.offset) },
            selection: selection
        )
    }
}

// MARK: - Segment

private struct Segment: View {
    let label: String
    var icon: String?
    let isSelected: Bool
    let action: () -> Void

    @State private var isHovered = false

    var body: some View {
        Button(action: action) {
            Group {
                if let icon {
                    VIconView(.resolve(icon), size: 12)
                } else {
                    Text(label)
                        .font(VFont.bodyMediumDefault)
                        .fixedSize()
                }
            }
            .foregroundStyle(isSelected ? VColor.contentEmphasized : VColor.contentSecondary)
            .padding(.horizontal, 10)
            .frame(maxWidth: .infinity)
            .frame(height: 28)
            .background(
                RoundedRectangle(cornerRadius: 6)
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
            return VColor.contentInset
        } else if isHovered {
            return VColor.surfaceActive
        } else {
            return .clear
        }
    }
}
