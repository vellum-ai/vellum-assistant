import SwiftUI

// MARK: - TableColumnLayout

/// Custom `Layout` that distributes the parent's proposed width among
/// table columns in a single layout pass. Fixed-width columns receive
/// their specified size (clamped to available space). Flexible columns
/// share the remaining width equally. Each subview = one column cell.
///
/// This participates directly in SwiftUI's layout system — no
/// GeometryReader, no measurement state, no re-render cycle.
private struct TableColumnLayout: Layout {
    /// Per-column spec: `nil` = flexible, `CGFloat` = fixed.
    let specs: [CGFloat?]
    /// Minimum width for flexible columns.
    let minFlexWidth: CGFloat

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout [CGFloat]) -> CGSize {
        let widths = resolvedWidths(for: proposal.width ?? 0, count: subviews.count)
        cache = widths
        let height = zip(subviews, widths).map { sub, w in
            sub.sizeThatFits(ProposedViewSize(width: w, height: nil)).height
        }.max() ?? 0
        return CGSize(width: widths.reduce(0, +), height: height)
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout [CGFloat]) {
        let widths = cache.isEmpty
            ? resolvedWidths(for: bounds.width, count: subviews.count)
            : cache
        var x = bounds.minX
        for (i, subview) in subviews.enumerated() {
            let w = i < widths.count ? widths[i] : 0
            subview.place(
                at: CGPoint(x: x, y: bounds.minY),
                anchor: .topLeading,
                proposal: ProposedViewSize(width: w, height: bounds.height)
            )
            x += w
        }
    }

    func makeCache(subviews: Subviews) -> [CGFloat] { [] }

    /// Distribute `available` width among `count` subviews based on `specs`.
    private func resolvedWidths(for available: CGFloat, count: Int) -> [CGFloat] {
        guard count > 0 else { return [] }
        let padded = specs + Array(repeating: nil as CGFloat?, count: max(0, count - specs.count))
        let effective = Array(padded.prefix(count))

        let fixedTotal = effective.compactMap { $0 }.reduce(0, +)
        let flexCount = effective.filter { $0 == nil }.count
        let flexWidth = flexCount > 0
            ? max(minFlexWidth, (available - fixedTotal) / CGFloat(flexCount))
            : 0

        return effective.map { spec in
            if let fixed = spec {
                return min(fixed, available)
            }
            return flexWidth
        }
    }
}

// MARK: - Constants

private let minColumnWidth: CGFloat = 60
private let selectionColumnWidth: CGFloat = 28
private let resizeHandleWidth: CGFloat = 8

// MARK: - InlineTableWidget

/// Inline table widget with selectable rows, resizable columns, and
/// optional horizontal scrolling.
///
/// Layout approach:
/// - A custom `TableColumnLayout` (the `Layout` protocol) distributes
///   the parent's proposed width among columns in a single layout pass.
/// - The selection checkbox column sits outside the Layout in an HStack,
///   so SwiftUI subtracts its 28pt before proposing width to the Layout.
/// - When total minimum widths exceed the available space, a horizontal
///   `ScrollView` activates as a fallback.
/// - Users can resize columns by dragging dividers in the header row.
public struct InlineTableWidget: View {
    public let data: TableSurfaceData
    public let onAction: (String, [String: AnyCodable]?) -> Void

    @State private var selectedIds: Set<String> = []
    /// User-resized column widths. Keyed by column ID.
    /// When absent, the column uses its default (fixed or flex) width.
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

    private var hasSelection: Bool {
        data.selectionMode != .none
    }

    /// Column specs for the Layout: user overrides take precedence,
    /// then backend fixed widths, then nil (flexible).
    private var columnSpecs: [CGFloat?] {
        data.columns.map { col in
            if let override = columnOverrides[col.id] {
                return override
            }
            if let fixed = col.width {
                return CGFloat(fixed)
            }
            return nil
        }
    }

    /// The Layout instance shared by header and all data rows.
    private var columnLayout: TableColumnLayout {
        TableColumnLayout(specs: columnSpecs, minFlexWidth: minColumnWidth)
    }

    /// Whether horizontal scrolling is needed (total minimums exceed container).
    /// The container width is 508pt (540pt card - 32pt padding).
    /// We use a conservative estimate since the actual proposed width
    /// comes from the parent at layout time.
    private var needsHorizontalScroll: Bool {
        let checkboxWidth: CGFloat = hasSelection ? selectionColumnWidth : 0
        let fixedTotal = columnSpecs.compactMap { $0 }.reduce(0, +)
        let flexCount = columnSpecs.filter { $0 == nil }.count
        let totalMin = checkboxWidth + fixedTotal + CGFloat(flexCount) * minColumnWidth
        return totalMin > 508
    }

    // MARK: - Body

    public var body: some View {
        VStack(alignment: .leading, spacing: VSpacing.sm) {
            if needsHorizontalScroll {
                ScrollView(.horizontal, showsIndicators: true) {
                    tableContent
                }
                .scrollClipDisabled(false)
            } else {
                tableContent
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
                    .frame(width: selectionColumnWidth)
                } else {
                    Color.clear.frame(width: selectionColumnWidth)
                }
            }

            columnLayout {
                ForEach(Array(data.columns.enumerated()), id: \.element.id) { index, column in
                    HStack(spacing: 0) {
                        Text(column.label)
                            .font(VFont.labelDefault)
                            .foregroundStyle(VColor.contentTertiary)
                            .textSelection(.enabled)
                            .frame(maxWidth: .infinity, alignment: .leading)

                        // Resize handle (between columns, not after the last one)
                        if index < data.columns.count - 1 {
                            resizeHandle(for: index)
                        }
                    }
                }
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
                    .frame(width: selectionColumnWidth)
                } else {
                    Color.clear.frame(width: selectionColumnWidth)
                }
            }

            columnLayout {
                ForEach(data.columns) { column in
                    cellView(row.cells[column.id])
                }
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
        .padding(.trailing, VSpacing.xs)
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
                        let currentWidth = columnOverrides[column.id]
                            ?? column.width.map { CGFloat($0) }
                            ?? estimatedFlexWidth()
                        let newWidth = max(minColumnWidth, currentWidth + value.translation.width)
                        columnOverrides[column.id] = newWidth
                    }
            )
    }

    /// Estimate the default flexible column width for drag baseline.
    /// Uses 508pt (card content area) as a reasonable default.
    private func estimatedFlexWidth() -> CGFloat {
        let checkboxWidth: CGFloat = hasSelection ? selectionColumnWidth : 0
        let fixedTotal = data.columns.compactMap(\.width).map { CGFloat($0) }.reduce(0, +)
        let flexCount = data.columns.filter({ $0.width == nil }).count
        guard flexCount > 0 else { return minColumnWidth }
        return max(minColumnWidth, (508 - checkboxWidth - fixedTotal) / CGFloat(flexCount))
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
