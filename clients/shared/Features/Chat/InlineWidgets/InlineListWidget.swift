import SwiftUI

/// Inline list widget for selectable items in chat.
public struct InlineListWidget: View {
    public let data: ListSurfaceData
    public let onAction: (String, [String: AnyCodable]?) -> Void

    @State private var selectedIds: Set<String> = []

    public init(data: ListSurfaceData, onAction: @escaping (String, [String: AnyCodable]?) -> Void) {
        self.data = data
        self.onAction = onAction
    }

    public var body: some View {
        VStack(alignment: .leading, spacing: VSpacing.xxs) {
            ForEach(data.items) { item in
                itemRow(item)
            }
        }
        .onAppear {
            selectedIds = Set(data.items.filter(\.selected).map(\.id))
            if data.selectionMode != .none {
                onAction("selection_changed", ["selectedIds": AnyCodable(Array(selectedIds))])
            }
        }
    }

    private func itemRow(_ item: ListItemData) -> some View {
        let isSelected = selectedIds.contains(item.id)
        return HStack(spacing: VSpacing.sm) {
            if let icon = item.icon {
                Text(icon)
                    .font(VFont.cardEmoji)
                    .frame(width: 32, height: 32)
            }

            VStack(alignment: .leading, spacing: VSpacing.xxs) {
                Text(item.title)
                    .font(VFont.bodyMedium)
                    .foregroundColor(VColor.contentDefault)

                if let subtitle = item.subtitle {
                    Text(subtitle)
                        .font(VFont.caption)
                        .foregroundColor(VColor.contentSecondary)
                        .lineLimit(1)
                }
            }

            Spacer()

            if data.selectionMode != .none {
                VIconView(isSelected ? .circleCheck : .circle, size: 14)
                    .foregroundColor(isSelected ? VColor.primaryBase : VColor.contentTertiary)
            }
        }
        .padding(.vertical, VSpacing.sm)
        .background(
            RoundedRectangle(cornerRadius: VRadius.sm)
                .fill(isSelected ? VColor.primaryBase.opacity(0.1) : Color.clear)
        )
        .contentShape(Rectangle())
        .onTapGesture {
            guard data.selectionMode != .none else { return }
            if data.selectionMode == .single {
                selectedIds = selectedIds.contains(item.id) ? [] : [item.id]
            } else {
                if selectedIds.contains(item.id) {
                    selectedIds.remove(item.id)
                } else {
                    selectedIds.insert(item.id)
                }
            }
            onAction("selection_changed", ["selectedIds": AnyCodable(Array(selectedIds))])
        }
    }
}

#if DEBUG
#Preview("InlineListWidget") {
    ZStack {
        VColor.surfaceOverlay.ignoresSafeArea()
        InlineListWidget(
            data: ListSurfaceData(
                items: [
                    ListItemData(id: "1", title: "Option A", subtitle: "First choice", icon: nil, selected: false),
                    ListItemData(id: "2", title: "Option B", subtitle: "Second choice", icon: nil, selected: true),
                    ListItemData(id: "3", title: "Option C", subtitle: nil, icon: nil, selected: false),
                ],
                selectionMode: .single
            ),
            onAction: { _, _ in }
        )
        .padding()
    }
    .frame(width: 400, height: 250)
}
#endif
