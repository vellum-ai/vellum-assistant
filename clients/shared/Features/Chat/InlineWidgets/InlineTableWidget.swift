import SwiftUI

// MARK: - Constants

private let minColumnWidth: CGFloat = 60
private let checkboxColumnWidth: CGFloat = 28
private let resizeHandleWidth: CGFloat = 8

// MARK: - InlineTableWidget

/// Inline table widget with selectable rows, resizable columns, and
/// optional horizontal scrolling.
///
/// Uses `onGeometryChange` (macOS 15) to measure the available container
/// width from a zero-height spacer, then distributes explicit
/// `frame(width:)` constraints across columns. Cells wrap text within
/// their allocated width via `.lineLimit(nil)`.
public struct InlineTableWidget: View {
    public let data: TableSurfaceData
    public let onAction: (String, [String: AnyCodable]?) -> Void

    @State private var selectedIds: Set<String> = []
    @State private var availableWidth: CGFloat = 0
    /// User-resized column widths keyed by column ID.
    @State private var columnOverrides: [String: CGFloat] = [:]

    public init(data: TableSurfaceData, onAction: @escaping (String, [String: AnyCodable]?) -> Void) {
        self.data = data
        self.onAction = onAction
    }

    // MARK: - Computed Properties

    private var selectableIds: Set<String> {
        Set(data.rows.filter(\.selectable).map(\.id))
    }

    private var allSelected: Bool {
        let ids = selectableIds
        return !ids.isEmpty && ids.isSubset(of: selectedIds)
    }

    private var hasSelection: Bool { data.selectionMode != .none }
    private var isMeasured: Bool { availableWidth > 0 }

    /// Width available for data columns (after subtracting checkbox if present).
    private var columnBudget: CGFloat {
        availableWidth - (hasSelection ? checkboxColumnWidth : 0)
    }

    /// Whether the table needs horizontal scrolling (column minimums exceed budget).
    private var needsHorizontalScroll: Bool {
        guard isMeasured else { return false }
        let fixedTotal = data.columns.compactMap(\.width).map { CGFloat($0) }.reduce(0, +)
        let flexCount = data.columns.filter({ $0.width == nil }).count
        return fixedTotal + CGFloat(flexCount) * minColumnWidth > columnBudget
    }

    /// Total content width when horizontal scrolling is active.
    private var scrollContentWidth: CGFloat {
        let fixedTotal = data.columns.compactMap(\.width).map { CGFloat($0) }.reduce(0, +)
        let flexCount = data.columns.filter({ $0.width == nil }).count
        return fixedTotal + CGFloat(flexCount) * minColumnWidth
    }

    // MARK: - Column Width Calculation

    /// Resolved width for a column. User overrides take precedence, then
    /// backend fixed widths, then equal flex distribution.
    private func columnWidth(for column: TableColumn) -> CGFloat {
        if let override = columnOverrides[column.id] {
            return override
        }
        if let fixed = column.width {
            return min(CGFloat(fixed), columnBudget)
        }
        let fixedTotal = data.columns.compactMap(\.width).map { CGFloat($0) }.reduce(0, +)
        let overrideTotal = columnOverrides.values.reduce(0, +)
        let flexCount = data.columns.filter({ $0.width == nil && columnOverrides[$0.id] == nil }).count
        guard flexCount > 0 else { return minColumnWidth }

        let budget = needsHorizontalScroll ? scrollContentWidth : columnBudget
        return max(minColumnWidth, (budget - fixedTotal - overrideTotal) / CGFloat(flexCount))
    }

    // MARK: - Body

    public var body: some View {
        VStack(alignment: .leading, spacing: VSpacing.sm) {
            // Zero-height spacer measures the parent's proposed width.
            // It has no intrinsic content so it always reports exactly
            // the proposed width — no overflow, no feedback loop.
            Color.clear
                .frame(height: 0)
                .frame(maxWidth: .infinity)
                .onGeometryChange(for: CGFloat.self) { $0.size.width } action: {
                    availableWidth = $0
                }

            if isMeasured {
                if needsHorizontalScroll {
                    ScrollView(.horizontal, showsIndicators: true) {
                        tableContent
                            .frame(width: scrollContentWidth + (hasSelection ? checkboxColumnWidth : 0))
                    }
                } else {
                    tableContent
                }
            }

            if let caption = data.caption {
                Text(caption)
                    .font(VFont.labelDefault)
                    .foregroundStyle(VColor.contentTertiary)
                    .padding(.top, VSpacing.xs)
            }
        }
        .clipped()
        .onAppear {
            selectedIds = Set(data.rows.filter(\.selected).map(\.id))
            if hasSelection {
                onAction("selection_changed", ["selectedIds": AnyCodable(Array(selectedIds))])
            }
        }
    }

    // MARK: - Table Content

    private var tableContent: some View {
        VStack(alignment: .leading, spacing: 0) {
            headerRow
                .padding(.bottom, VSpacing.xxs)

            Divider()
                .background(VColor.borderBase.opacity(0.3))

            ForEach(Array(data.rows.enumerated()), id: \.element.id) { index, row in
                dataRow(row)
                if index < data.rows.count - 1 {
                    Divider()
                        .background(VColor.borderBase.opacity(0.15))
                }
            }
        }
    }

    // MARK: - Header Row

    private var headerRow: some View {
        HStack(spacing: 0) {
            if hasSelection {
                if data.selectionMode == .multiple {
                    Button {
                        toggleSelectAll()
                    } label: {
                        VIconView(allSelected ? .circleCheck : .circle, size: 14)
                            .foregroundStyle(allSelected ? VColor.primaryBase : VColor.contentTertiary)
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel(allSelected ? "Deselect all" : "Select all")
                    .frame(width: checkboxColumnWidth)
                } else {
                    Color.clear.frame(width: checkboxColumnWidth)
                }
            }

            ForEach(Array(data.columns.enumerated()), id: \.element.id) { index, column in
                HStack(spacing: 0) {
                    Text(column.label)
                        .font(VFont.labelDefault)
                        .foregroundStyle(VColor.contentTertiary)
                        .textSelection(.enabled)
                        .lineLimit(1)

                    Spacer(minLength: 0)

                    if index < data.columns.count - 1 {
                        resizeHandle(for: index)
                    }
                }
                .frame(width: columnWidth(for: column), alignment: .leading)
            }
        }
    }

    // MARK: - Data Row

    private func dataRow(_ row: TableRow) -> some View {
        let isSelected = selectedIds.contains(row.id)
        return HStack(spacing: 0) {
            if hasSelection {
                if row.selectable {
                    Button {
                        toggleSelection(row.id)
                    } label: {
                        VIconView(isSelected ? .circleCheck : .circle, size: 14)
                            .foregroundStyle(isSelected ? VColor.primaryBase : VColor.contentTertiary)
                    }
                    .buttonStyle(.plain)
                    .frame(width: checkboxColumnWidth)
                } else {
                    Color.clear.frame(width: checkboxColumnWidth)
                }
            }

            ForEach(data.columns) { column in
                cellView(row.cells[column.id])
                    .frame(width: columnWidth(for: column), alignment: .leading)
            }
        }
        .padding(.vertical, VSpacing.xs)
        .background(
            RoundedRectangle(cornerRadius: VRadius.sm)
                .fill(isSelected ? VColor.primaryBase.opacity(0.1) : Color.clear)
        )
        .contentShape(Rectangle())
        .onTapGesture {
            if row.selectable && hasSelection {
                toggleSelection(row.id)
            }
        }
    }

    // MARK: - Cell View

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

    // MARK: - Resize Handle

    private func resizeHandle(for columnIndex: Int) -> some View {
        Rectangle()
            .fill(Color.clear)
            .frame(width: resizeHandleWidth)
            .overlay(
                Rectangle()
                    .fill(VColor.borderBase.opacity(0.2))
                    .frame(width: 1)
            )
            .contentShape(Rectangle())
            #if os(macOS)
            .onHover { hovering in
                if hovering {
                    NSCursor.resizeLeftRight.push()
                } else {
                    NSCursor.pop()
                }
            }
            #endif
            .gesture(
                DragGesture(minimumDistance: 1)
                    .onChanged { value in
                        let column = data.columns[columnIndex]
                        let current = columnOverrides[column.id]
                            ?? column.width.map { CGFloat($0) }
                            ?? columnWidth(for: column)
                        columnOverrides[column.id] = max(minColumnWidth, current + value.translation.width)
                    }
            )
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
