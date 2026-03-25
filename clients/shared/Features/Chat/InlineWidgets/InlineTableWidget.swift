import SwiftUI

// MARK: - TableRowLayout

/// Custom `Layout` that distributes available width among table columns
/// in a single layout pass — no measurement state, no re-renders.
///
/// Fixed-width columns receive their specified size (clamped to available
/// space). Flexible columns share the remaining width equally. Each child
/// view corresponds to one column cell (plus an optional leading selection
/// cell when `selectionWidth > 0`).
private struct TableRowLayout: Layout {
    let columnWidths: [Int?]
    let selectionWidth: CGFloat

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        let width = proposal.width ?? 0
        let resolvedWidths = resolveColumnWidths(for: width)
        let heights = subviewHeights(subviews: subviews, columnWidths: resolvedWidths)
        return CGSize(width: width, height: heights.max() ?? 0)
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        let resolvedWidths = resolveColumnWidths(for: bounds.width)
        var x = bounds.minX

        for (index, subview) in subviews.enumerated() {
            let colWidth = resolvedWidths[index]
            let cellProposal = ProposedViewSize(width: colWidth, height: nil)
            subview.place(at: CGPoint(x: x, y: bounds.minY), anchor: .topLeading, proposal: cellProposal)
            x += colWidth
        }
    }

    // MARK: - Column Width Resolution

    /// Distribute `totalWidth` among the selection column (if any) and data columns.
    /// Returns one width per subview (selection + columns).
    private func resolveColumnWidths(for totalWidth: CGFloat) -> [CGFloat] {
        var widths: [CGFloat] = []
        var remaining = totalWidth

        // Selection column
        if selectionWidth > 0 {
            let sel = min(selectionWidth, remaining)
            widths.append(sel)
            remaining -= sel
        }

        // Data columns
        let fixedTotal = CGFloat(columnWidths.compactMap { $0 }.reduce(0, +))
        let flexCount = columnWidths.filter { $0 == nil }.count
        let flexWidth = flexCount > 0 ? max(0, (remaining - fixedTotal) / CGFloat(flexCount)) : 0

        for colWidth in columnWidths {
            if let fixed = colWidth {
                let clamped = min(CGFloat(fixed), remaining)
                widths.append(clamped)
            } else {
                widths.append(flexWidth)
            }
        }

        return widths
    }

    /// Measure each subview's height given its resolved column width.
    private func subviewHeights(subviews: Subviews, columnWidths: [CGFloat]) -> [CGFloat] {
        zip(subviews, columnWidths).map { subview, width in
            subview.sizeThatFits(ProposedViewSize(width: width, height: nil)).height
        }
    }
}

// MARK: - InlineTableWidget

/// Inline table widget with selectable rows and action support.
///
/// Uses a custom `TableRowLayout` (the `Layout` protocol) to distribute
/// the parent's proposed width among columns in a single layout pass —
/// no GeometryReader, no measurement state, no re-render cycle.
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

    /// The `TableRowLayout` configuration shared by headers and all data rows.
    private var rowLayout: TableRowLayout {
        TableRowLayout(
            columnWidths: data.columns.map(\.width),
            selectionWidth: data.selectionMode != .none ? 28 : 0
        )
    }

    // MARK: - Body

    public var body: some View {
        VStack(alignment: .leading, spacing: VSpacing.sm) {
            // Column headers
            rowLayout {
                if data.selectionMode == .multiple {
                    Button {
                        toggleSelectAll()
                    } label: {
                        VIconView(allSelected ? .circleCheck : .circle, size: 14)
                            .foregroundStyle(allSelected ? VColor.primaryBase : VColor.contentTertiary)
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel(allSelected ? "Deselect all" : "Select all")
                } else if data.selectionMode != .none {
                    Color.clear
                }

                ForEach(data.columns) { column in
                    Text(column.label)
                        .font(VFont.labelDefault)
                        .foregroundStyle(VColor.contentTertiary)
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
        .onAppear {
            selectedIds = Set(data.rows.filter(\.selected).map(\.id))
            if data.selectionMode != .none {
                onAction("selection_changed", ["selectedIds": AnyCodable(Array(selectedIds))])
            }
        }
    }

    // MARK: - Row & Cell Views

    private func rowView(_ row: TableRow) -> some View {
        let isSelected = selectedIds.contains(row.id)
        return rowLayout {
            if data.selectionMode != .none && row.selectable {
                Button {
                    toggleSelection(row.id)
                } label: {
                    VIconView(isSelected ? .circleCheck : .circle, size: 14)
                        .foregroundStyle(isSelected ? VColor.primaryBase : VColor.contentTertiary)
                }
                .buttonStyle(.plain)
            } else if data.selectionMode != .none {
                Color.clear
            }

            ForEach(data.columns) { column in
                cellView(row.cells[column.id])
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
    private func cellView(_ value: TableCellValue?) -> some View {
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
