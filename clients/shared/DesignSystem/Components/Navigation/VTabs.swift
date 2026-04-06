import SwiftUI

public struct VTabs<SelectionValue: Hashable>: View {
    public let items: [(label: String, tag: SelectionValue)]
    @Binding public var selection: SelectionValue

    public init(items: [(label: String, tag: SelectionValue)], selection: Binding<SelectionValue>) {
        self.items = items
        self._selection = selection
    }

    public var body: some View {
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
}

// MARK: - Int convenience initializer

public extension VTabs where SelectionValue == Int {
    init(items: [String], selection: Binding<Int>) {
        self.init(
            items: items.enumerated().map { (label: $0.element, tag: $0.offset) },
            selection: selection
        )
    }
}
