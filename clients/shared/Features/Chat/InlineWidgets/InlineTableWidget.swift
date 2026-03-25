import SwiftUI

/// Inline table widget with selectable rows and action support.
///
/// Follows the same layout pattern as `MarkdownTableView`: measures the
/// available container width, applies it as a hard `.frame(width:)`
/// constraint on the table VStack, and lets cells share that constrained
/// space via `.frame(maxWidth: .infinity)`. This guarantees text wraps
/// within columns and the table never overflows its container.
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

    // MARK: - Body

    public var body: some View {
        // Outer wrapper: invisible spacer measures available width,
        // then the table renders at that exact width.
        VStack(spacing: 0) {
            // Measure available width from a contentless view that can't
            // overflow — it always reports the parent's proposed width.
            Color.clear
                .frame(height: 0)
                .frame(maxWidth: .infinity)
                .onGeometryChange(for: CGFloat.self) { $0.size.width } action: {
                    tableWidth = $0
                }

            if tableWidth > 0 {
                tableBody
                    // Hard width constraint — the key to preventing overflow.
                    // Identical to MarkdownTableView's .frame(maxWidth: maxWidth).
                    // Forces the VStack and all children to lay out within this
                    // exact width. Cells with .frame(maxWidth: .infinity) then
                    // share this constrained space equally.
                    .frame(width: tableWidth, alignment: .leading)
            }
        }
        .onAppear {
            selectedIds = Set(data.rows.filter(\.selected).map(\.id))
            if data.selectionMode != .none {
                onAction("selection_changed", ["selectedIds": AnyCodable(Array(selectedIds))])
            }
        }
    }

    // MARK: - Table Content

    /// The actual table layout. Identical pattern to `MarkdownTableView`:
    /// each cell uses `.frame(maxWidth: .infinity)` to share the parent's
    /// constrained width equally.
    private var tableBody: some View {
        VStack(alignment: .leading, spacing: VSpacing.sm) {
            // Column headers
            HStack(spacing: 0) {
                selectionCell(isHeader: true)
                ForEach(data.columns) { column in
                    Text(column.label)
                        .font(VFont.labelDefault)
                        .foregroundStyle(VColor.contentTertiary)
                        .textSelection(.enabled)
                        .cellFrame(column.width)
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
    }

    // MARK: - Row & Cell Views

    @ViewBuilder
    private func selectionCell(isHeader: Bool = false) -> some View {
        if data.selectionMode == .multiple && isHeader {
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
    }

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
                cellView(row.cells[column.id], columnWidth: column.width)
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
    private func cellView(_ value: TableCellValue?, columnWidth: Int?) -> some View {
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
        .cellFrame(columnWidth)
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

// MARK: - Cell Sizing

private extension View {
    /// Fixed-width columns get their specified size.
    /// Flexible columns use `.frame(maxWidth: .infinity)` to share the
    /// parent's constrained width equally — the same pattern MarkdownTableView uses.
    @ViewBuilder
    func cellFrame(_ width: Int?) -> some View {
        if let w = width {
            self.frame(width: CGFloat(w), alignment: .leading)
        } else {
            self.frame(maxWidth: .infinity, alignment: .leading)
        }
    }
}
