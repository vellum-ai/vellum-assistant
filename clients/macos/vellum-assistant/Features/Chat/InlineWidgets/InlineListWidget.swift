import SwiftUI

/// Inline list widget for selectable items in chat.
struct InlineListWidget: View {
    let data: ListSurfaceData
    let onAction: (String, [String: AnyCodable]?) -> Void

    @State private var selectedIds: Set<String> = []

    var body: some View {
        VStack(alignment: .leading, spacing: VSpacing.xxs) {
            ForEach(data.items) { item in
                itemRow(item)
            }
        }
        .onAppear {
            selectedIds = Set(data.items.filter(\.selected).map(\.id))
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
                    .foregroundColor(VColor.textPrimary)

                if let subtitle = item.subtitle {
                    Text(subtitle)
                        .font(VFont.caption)
                        .foregroundColor(VColor.textSecondary)
                        .lineLimit(1)
                }
            }

            Spacer()

            if data.selectionMode != .none {
                Image(systemName: isSelected ? "checkmark.circle.fill" : "circle")
                    .font(.system(size: 14))
                    .foregroundColor(isSelected ? VColor.accent : VColor.textMuted)
            }
        }
        .padding(.horizontal, VSpacing.sm)
        .padding(.vertical, VSpacing.sm)
        .background(
            RoundedRectangle(cornerRadius: VRadius.sm)
                .fill(isSelected ? VColor.accent.opacity(0.1) : Color.clear)
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
        VColor.background.ignoresSafeArea()
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
