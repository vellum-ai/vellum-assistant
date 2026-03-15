import SwiftUI

private extension View {
    @ViewBuilder
    func columnFrame(_ width: Int?) -> some View {
        if let w = width {
            self.frame(width: CGFloat(w), alignment: .leading)
        } else {
            self.frame(maxWidth: .infinity, alignment: .leading)
        }
    }
}

/// Inline table widget with selectable rows and action support.
public struct InlineTableWidget: View {
    public let data: TableSurfaceData
    public let onAction: (String, [String: AnyCodable]?) -> Void

    @State private var selectedIds: Set<String> = []

    public init(data: TableSurfaceData, onAction: @escaping (String, [String: AnyCodable]?) -> Void) {
        self.data = data
        self.onAction = onAction
    }

    private var selectableIds: Set<String> {
        Set(data.rows.filter(\.selectable).map(\.id))
    }

    private var allSelected: Bool {
        let ids = selectableIds
        return !ids.isEmpty && ids.isSubset(of: selectedIds)
    }

    public var body: some View {
        VStack(alignment: .leading, spacing: VSpacing.sm) {
            // Column headers
            HStack(spacing: 0) {
                if data.selectionMode == .multiple {
                    Button {
                        toggleSelectAll()
                    } label: {
                        VIconView(allSelected ? .circleCheck : .circle, size: 14)
                            .foregroundColor(allSelected ? VColor.primaryBase : VColor.contentTertiary)
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel(allSelected ? "Deselect all" : "Select all")
                    .frame(width: 28)
                } else if data.selectionMode != .none {
                    Color.clear
                        .frame(width: 28)
                }
                ForEach(data.columns) { column in
                    Text(column.label)
                        .font(VFont.captionMedium)
                        .foregroundColor(VColor.contentTertiary)
                        .columnFrame(column.width)
                        .textSelection(.enabled)
                }
            }
            .padding(.bottom, VSpacing.xxs)

            Divider()
                .background(VColor.borderBase.opacity(0.3))

            // Rows
            ForEach(data.rows) { row in
                rowView(row)
            }

            if let caption = data.caption {
                Text(caption)
                    .font(VFont.caption)
                    .foregroundColor(VColor.contentTertiary)
                    .padding(.top, VSpacing.xs)
            }
        }
        .onAppear {
            // Initialize selection from data and notify the parent so action
            // buttons always carry the current selection — even if the user
            // never toggles a checkbox.
            selectedIds = Set(data.rows.filter(\.selected).map(\.id))
            if data.selectionMode != .none {
                onAction("selection_changed", ["selectedIds": AnyCodable(Array(selectedIds))])
            }
        }
    }

    private func rowView(_ row: TableRow) -> some View {
        let isSelected = selectedIds.contains(row.id)
        return HStack(spacing: 0) {
            if data.selectionMode != .none && row.selectable {
                Button {
                    toggleSelection(row.id)
                } label: {
                    VIconView(isSelected ? .circleCheck : .circle, size: 14)
                        .foregroundColor(isSelected ? VColor.primaryBase : VColor.contentTertiary)
                }
                .buttonStyle(.plain)
                .frame(width: 28)
            } else if data.selectionMode != .none {
                Color.clear
                    .frame(width: 28)
            }

            ForEach(data.columns) { column in
                cellView(row.cells[column.id], width: column.width)
            }
        }
        .padding(.vertical, VSpacing.xs)
        .background(
            RoundedRectangle(cornerRadius: VRadius.sm)
                .fill(isSelected ? VColor.primaryBase.opacity(0.1) : Color.clear)
        )
        .contentShape(Rectangle())
        .onTapGesture {
            if row.selectable && data.selectionMode != .none {
                toggleSelection(row.id)
            }
        }
    }

    @ViewBuilder
    private func cellView(_ value: TableCellValue?, width: Int?) -> some View {
        HStack(spacing: VSpacing.xs) {
            if let icon = value?.icon,
               let vIcon = SFSymbolMapping.icon(forSFSymbol: icon) {
                VIconView(vIcon, size: 12)
                    .foregroundColor(resolveIconColor(value?.iconColor))
            }
            Text(value?.text ?? "")
                .font(VFont.body)
                .foregroundColor(VColor.contentDefault)
                .lineLimit(2)
                .textSelection(.enabled)
        }
        .columnFrame(width)
    }

    private func resolveIconColor(_ token: String?) -> Color {
        switch token {
        case "success": return VColor.systemPositiveStrong
        case "warning": return VColor.systemNegativeHover
        case "error": return VColor.systemNegativeStrong
        case "muted": return VColor.contentTertiary
        default: return VColor.contentDefault
        }
    }

    private func toggleSelectAll() {
        if allSelected {
            selectedIds.subtract(selectableIds)
        } else {
            selectedIds.formUnion(selectableIds)
        }
        onAction("selection_changed", ["selectedIds": AnyCodable(Array(selectedIds))])
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
#endif
