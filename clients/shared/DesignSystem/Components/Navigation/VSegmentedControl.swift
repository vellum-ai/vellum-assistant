import SwiftUI

public enum VSegmentedControlStyle {
    case underline
    case pill
}

public struct VSegmentedControl<SelectionValue: Hashable>: View {
    public let items: [(label: String, tag: SelectionValue)]
    @Binding public var selection: SelectionValue
    public let style: VSegmentedControlStyle

    public init(items: [(label: String, tag: SelectionValue)], selection: Binding<SelectionValue>, style: VSegmentedControlStyle = .underline) {
        self.items = items
        self._selection = selection
        self.style = style
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
                            .foregroundColor(selection == item.tag ? VColor.textPrimary : VColor.textMuted)
                            .padding(.horizontal, VSpacing.xl)
                            .padding(.vertical, VSpacing.xs)

                        Rectangle()
                            .fill(selection == item.tag ? VColor.accent : .clear)
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
                    isSelected: selection == item.tag,
                    action: { selection = item.tag }
                )
            }
        }
        .padding(2)
        .background(
            RoundedRectangle(cornerRadius: VRadius.md)
                .fill(VColor.inputBackground)
        )
        .animation(VAnimation.fast, value: selection)
    }
}

// MARK: - Int convenience initializer

public extension VSegmentedControl where SelectionValue == Int {
    init(items: [String], selection: Binding<Int>, style: VSegmentedControlStyle = .underline) {
        self.init(
            items: items.enumerated().map { (label: $0.element, tag: $0.offset) },
            selection: selection,
            style: style
        )
    }
}

// MARK: - Pill Segment

private struct PillSegment: View {
    let label: String
    let isSelected: Bool
    let action: () -> Void

    @State private var isHovered = false

    var body: some View {
        Button(action: action) {
            Text(label)
                .font(VFont.body)
                .fixedSize()
                .foregroundColor(isSelected ? selectedTextColor : VColor.textSecondary)
                .padding(.horizontal, VSpacing.lg)
                .padding(.vertical, VSpacing.xs + 2)
                .frame(maxWidth: .infinity)
                .background(
                    RoundedRectangle(cornerRadius: VRadius.md - 1)
                        .fill(segmentBackground)
                        .shadow(color: isSelected ? Color.black.opacity(0.08) : .clear, radius: 2, x: 0, y: 1)
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
        VColor.textPrimary
    }

    private var segmentBackground: Color {
        if isSelected {
            return VColor.segmentSelected
        } else if isHovered {
            return VColor.segmentHover
        } else {
            return .clear
        }
    }
}

#if DEBUG
struct VSegmentedControl_Preview: PreviewProvider {
    static var previews: some View {
        VSegmentedControlPreviewWrapper()
            .frame(width: 500, height: 120)
            .previewDisplayName("VSegmentedControl")
    }
}

private struct VSegmentedControlPreviewWrapper: View {
    @State private var selection = 1
    @State private var pillSelection = "dark"

    var body: some View {
        ZStack {
            VColor.background.ignoresSafeArea()
            VStack(spacing: VSpacing.xl) {
                VSegmentedControl(items: ["Profile", "Settings", "Channels", "Overview"], selection: $selection)

                VSegmentedControl(
                    items: [
                        (label: "System", tag: "system"),
                        (label: "Light", tag: "light"),
                        (label: "Dark", tag: "dark"),
                    ],
                    selection: $pillSelection,
                    style: .pill
                )
                .frame(width: 240)
            }
        }
    }
}
#endif
