import VellumAssistantShared
import SwiftUI

struct ListSurfaceView: View {
    let data: ListSurfaceData
    let onSelect: ([String]) -> Void

    @State private var selectedIds: Set<String> = []

    var body: some View {
        ScrollView {
            VStack(spacing: 0) {
                ForEach(data.items) { item in
                    VListRow(onTap: data.selectionMode != .none ? { toggleSelection(item) } : nil) {
                        HStack(spacing: VSpacing.md) {
                            if let icon = item.icon {
                                VIconView(SFSymbolMapping.icon(forSFSymbol: icon, fallback: .puzzle), size: 14)
                                    .foregroundStyle(VColor.contentTertiary)
                            }

                            VStack(alignment: .leading, spacing: VSpacing.xxs) {
                                Text(item.title)
                                    .font(VFont.bodyMediumDefault)
                                    .foregroundStyle(VColor.contentDefault)

                                if let subtitle = item.subtitle {
                                    Text(subtitle)
                                        .font(VFont.labelDefault)
                                        .foregroundStyle(VColor.contentSecondary)
                                }
                            }

                            Spacer()

                            if data.selectionMode != .none && selectedIds.contains(item.id) {
                                VIconView(.check, size: 14)
                                    .foregroundStyle(VColor.primaryBase)
                            }
                        }
                    }
                }
            }
        }
        .onAppear {
            // Initialize from pre-selected items
            selectedIds = Set(data.items.filter(\.selected).map(\.id))
        }
    }

    private func toggleSelection(_ item: ListItemData) {
        switch data.selectionMode {
        case .single:
            if selectedIds.contains(item.id) {
                selectedIds.removeAll()
            } else {
                selectedIds = [item.id]
            }
        case .multiple:
            if selectedIds.contains(item.id) {
                selectedIds.remove(item.id)
            } else {
                selectedIds.insert(item.id)
            }
        case .none:
            return
        }
        onSelect(Array(selectedIds))
    }
}
