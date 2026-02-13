import SwiftUI

/// Inline table widget with selectable rows and action support.
struct InlineTableWidget: View {
    let data: TableSurfaceData
    let onAction: (String, [String: AnyCodable]?) -> Void

    @State private var selectedIds: Set<String> = []

    var body: some View {
        VStack(alignment: .leading, spacing: VSpacing.sm) {
            // Column headers
            HStack(spacing: 0) {
                if data.selectionMode != .none {
                    // Checkbox column header
                    Color.clear
                        .frame(width: 28)
                }
                ForEach(data.columns) { column in
                    Text(column.label)
                        .font(VFont.captionMedium)
                        .foregroundColor(VColor.textMuted)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
            }
            .padding(.horizontal, VSpacing.sm)
            .padding(.bottom, VSpacing.xxs)

            Divider()
                .background(VColor.surfaceBorder.opacity(0.3))

            // Rows
            ForEach(data.rows) { row in
                rowView(row)
            }

            if let caption = data.caption {
                Text(caption)
                    .font(VFont.caption)
                    .foregroundColor(VColor.textMuted)
                    .padding(.top, VSpacing.xs)
            }
        }
        .onAppear {
            // Initialize selection from data
            selectedIds = Set(data.rows.filter(\.selected).map(\.id))
        }
    }

    private func rowView(_ row: TableRow) -> some View {
        let isSelected = selectedIds.contains(row.id)
        return HStack(spacing: 0) {
            if data.selectionMode != .none && row.selectable {
                Button {
                    toggleSelection(row.id)
                } label: {
                    Image(systemName: isSelected ? "checkmark.circle.fill" : "circle")
                        .font(.system(size: 14))
                        .foregroundColor(isSelected ? VColor.accent : VColor.textMuted)
                }
                .buttonStyle(.plain)
                .frame(width: 28)
            } else if data.selectionMode != .none {
                Color.clear
                    .frame(width: 28)
            }

            ForEach(data.columns) { column in
                Text(row.cells[column.id] ?? "")
                    .font(VFont.body)
                    .foregroundColor(VColor.textPrimary)
                    .lineLimit(2)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
        }
        .padding(.horizontal, VSpacing.sm)
        .padding(.vertical, VSpacing.xs)
        .background(
            RoundedRectangle(cornerRadius: VRadius.sm)
                .fill(isSelected ? VColor.accent.opacity(0.1) : Color.clear)
        )
        .contentShape(Rectangle())
        .onTapGesture {
            if row.selectable && data.selectionMode != .none {
                toggleSelection(row.id)
            }
        }
    }

    private func toggleSelection(_ id: String) {
        if data.selectionMode == .single {
            if selectedIds.contains(id) {
                selectedIds.removeAll()
            } else {
                selectedIds = [id]
            }
        } else {
            if selectedIds.contains(id) {
                selectedIds.remove(id)
            } else {
                selectedIds.insert(id)
            }
        }
        onAction("selection_changed", ["selectedIds": AnyCodable(Array(selectedIds))])
    }
}

#if DEBUG
#Preview("InlineTableWidget") {
    ZStack {
        VColor.background.ignoresSafeArea()
        InlineTableWidget(
            data: TableSurfaceData(
                columns: [
                    TableColumn(id: "sender", label: "Sender", width: nil),
                    TableColumn(id: "count", label: "Emails", width: nil),
                ],
                rows: [
                    TableRow(id: "1", cells: ["sender": "newsletter@tech.co", "count": "47"], selectable: true, selected: false),
                    TableRow(id: "2", cells: ["sender": "deals@store.com", "count": "32"], selectable: true, selected: false),
                    TableRow(id: "3", cells: ["sender": "updates@social.app", "count": "28"], selectable: true, selected: false),
                ],
                selectionMode: .multiple,
                caption: "3 newsletters found from last 30 days"
            ),
            onAction: { _, _ in }
        )
        .padding()
    }
    .frame(width: 500, height: 300)
}
#endif
