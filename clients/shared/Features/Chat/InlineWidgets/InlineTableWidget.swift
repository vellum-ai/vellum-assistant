import SwiftUI

/// Inline table widget with selectable rows and action support.
///
/// Measures the available container width via `onGeometryChange` and
/// distributes it among columns explicitly, so text wraps within
/// each column instead of overflowing the viewport.
public struct InlineTableWidget: View {
    public let data: TableSurfaceData
    public let onAction: (String, [String: AnyCodable]?) -> Void

    @State private var selectedIds: Set<String> = []
    @State private var tableWidth: CGFloat = 0

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

    // MARK: - Column Width Calculation

    /// Width reserved for the selection checkbox / spacer column.
    private var selectionColumnWidth: CGFloat {
        data.selectionMode != .none ? 28 : 0
    }

    /// Resolved width for a single column. Fixed-width columns use their
    /// specified value; flexible columns share the remaining space equally.
    private func columnWidth(for column: TableColumn) -> CGFloat {
        if let w = column.width {
            return CGFloat(w)
        }
        guard tableWidth > 0 else { return 0 }
        let fixedTotal = CGFloat(data.columns.compactMap(\.width).reduce(0, +))
        let flexCount = data.columns.filter({ $0.width == nil }).count
        guard flexCount > 0 else { return 0 }
        return max(0, (tableWidth - fixedTotal - selectionColumnWidth) / CGFloat(flexCount))
    }

    // MARK: - Body

    public var body: some View {
        VStack(alignment: .leading, spacing: VSpacing.sm) {
            // Column headers
            HStack(spacing: 0) {
                if data.selectionMode == .multiple {
                    Button {
                        toggleSelectAll()
                    } label: {
                        VIconView(allSelected ? .circleCheck : .circle, size: 14)
                            .foregroundStyle(allSelected ? VColor.primaryBase : VColor.contentTertiary)
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
                        .font(VFont.labelDefault)
                        .foregroundStyle(VColor.contentTertiary)
                        .frame(width: columnWidth(for: column), alignment: .leading)
                        .textSelection(.enabled)
                }
            }
            .padding(.bottom, VSpacing.xxs)

            Divider()
                .background(VColor.borderBase.opacity(0.3))

            // Rows
            ForEach(Array(data.rows.enumerated()), id: \.element.id) { index, row in
                rowView(row)
                if index < data.rows.count - 1 {
                    Divider()
                        .background(VColor.borderBase.opacity(0.15))
                }
            }

            if let caption = data.caption {
                Text(caption)
                    .font(VFont.labelDefault)
                    .foregroundStyle(VColor.contentTertiary)
                    .padding(.top, VSpacing.xs)
            }
        }
        .onGeometryChange(for: CGFloat.self) { proxy in
            proxy.size.width
        } action: { newWidth in
            tableWidth = newWidth
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

    // MARK: - Row & Cell Views

    private func rowView(_ row: TableRow) -> some View {
        let isSelected = selectedIds.contains(row.id)
        return HStack(spacing: 0) {
            if data.selectionMode != .none && row.selectable {
                Button {
                    toggleSelection(row.id)
                } label: {
                    VIconView(isSelected ? .circleCheck : .circle, size: 14)
                        .foregroundStyle(isSelected ? VColor.primaryBase : VColor.contentTertiary)
                }
                .buttonStyle(.plain)
                .frame(width: 28)
            } else if data.selectionMode != .none {
                Color.clear
                    .frame(width: 28)
            }

            ForEach(data.columns) { column in
                cellView(row.cells[column.id], width: columnWidth(for: column))
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
    private func cellView(_ value: TableCellValue?, width: CGFloat) -> some View {
        HStack(spacing: VSpacing.xs) {
            if let icon = value?.icon,
               let vIcon = SFSymbolMapping.icon(forSFSymbol: icon) {
                VIconView(vIcon, size: 12)
                    .foregroundStyle(resolveIconColor(value?.iconColor))
            }
            Text(value?.text ?? "")
                .font(VFont.bodyMediumLighter)
                .foregroundStyle(VColor.contentDefault)
                .lineLimit(nil)
                .textSelection(.enabled)
        }
        .frame(width: width, alignment: .leading)
    }

    // MARK: - Helpers

    private func resolveIconColor(_ token: String?) -> Color {
        switch token {
        case "success": return VColor.systemPositiveStrong
        case "warning": return VColor.systemMidStrong
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
