import SwiftUI
#if os(macOS)
import AppKit
#endif

// MARK: - TableColumnLayout

/// Custom `Layout` that distributes the parent's proposed width among
/// table columns in a single layout pass. Fixed-width columns retain
/// their configured width. Flexible columns share any extra width, but
/// never shrink below a minimum. Each subview = one column cell.
///
/// This participates directly in SwiftUI's layout system — no
/// GeometryReader, no measurement state, no re-render cycle.
private struct TableColumnLayout: Layout {
    /// Per-column spec: `nil` = flexible, `CGFloat` = fixed.
    let specs: [CGFloat?]
    /// Minimum width for flexible columns.
    let minFlexWidth: CGFloat

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout [CGFloat]) -> CGSize {
        let widths = resolvedWidths(for: proposal.width, count: subviews.count)
        cache = widths
        let height = zip(subviews, widths).map { sub, w in
            sub.sizeThatFits(ProposedViewSize(width: w, height: nil)).height
        }.max() ?? 0
        return CGSize(width: widths.reduce(0, +), height: height)
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout [CGFloat]) {
        let widths = cache.isEmpty
            ? resolvedWidths(for: proposal.width ?? bounds.width, count: subviews.count)
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
    private func resolvedWidths(for available: CGFloat?, count: Int) -> [CGFloat] {
        guard count > 0 else { return [] }
        let padded = specs + Array(repeating: nil as CGFloat?, count: max(0, count - specs.count))
        let effective = Array(padded.prefix(count))

        let normalizedFixed = effective.map { spec in
            spec.map { max(0, $0) }
        }
        let fixedTotal = normalizedFixed.compactMap { $0 }.reduce(0, +)
        let flexCount = normalizedFixed.filter { $0 == nil }.count
        let minimumTotal = fixedTotal + CGFloat(flexCount) * minFlexWidth

        let constrainedWidth: CGFloat?
        if let available, available.isFinite, available > 0 {
            constrainedWidth = available
        } else {
            constrainedWidth = nil
        }

        let flexWidth: CGFloat
        if flexCount == 0 {
            flexWidth = 0
        } else if let constrainedWidth, constrainedWidth > minimumTotal {
            let extraPerColumn = (constrainedWidth - minimumTotal) / CGFloat(flexCount)
            flexWidth = minFlexWidth + extraPerColumn
        } else {
            flexWidth = minFlexWidth
        }

        return normalizedFixed.map { spec in
            if let fixed = spec {
                return fixed
            }
            return flexWidth
        }
    }
}

// MARK: - Constants

private let minColumnWidth: CGFloat = 60
private let selectionColumnWidth: CGFloat = 28
private let resizeHandleWidth: CGFloat = 18
private let resizeGestureCoordinateSpaceName = "InlineTableWidgetResize"

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
    /// Baseline width captured at drag start for each column.
    @State private var resizeDragStartWidths: [String: CGFloat] = [:]
    @State private var activeResizeHandleIndex: Int?

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

    /// Minimum content width before the table overflows horizontally.
    private var minimumTableWidth: CGFloat {
        let checkboxWidth: CGFloat = hasSelection ? selectionColumnWidth : 0
        let handleTotal = CGFloat(max(0, data.columns.count - 1)) * resizeHandleWidth
        let fixedTotal = columnSpecs.compactMap { $0 }.reduce(0, +)
        let flexCount = columnSpecs.filter { $0 == nil }.count
        return checkboxWidth + handleTotal + fixedTotal + CGFloat(flexCount) * minColumnWidth
    }

    /// Table content viewport width inside the card chrome when fully expanded.
    private var maxTableViewportWidth: CGFloat {
        max(minColumnWidth, VSpacing.chatBubbleMaxWidth - 2 * VSpacing.lg)
    }

    private var needsHorizontalScroll: Bool {
        minimumTableWidth > maxTableViewportWidth + 1
    }

    private var shouldShowHorizontalHint: Bool {
        needsHorizontalScroll
    }

    private var isResizingColumn: Bool {
        activeResizeHandleIndex != nil
    }

    // MARK: - Body

    public var body: some View {
        VStack(alignment: .leading, spacing: VSpacing.sm) {
            tableContainer

            if let caption = data.caption {
                Text(caption)
                    .font(VFont.labelDefault)
                    .foregroundStyle(VColor.contentTertiary)
                    .padding(.top, VSpacing.xs)
            }
        }
        .onAppear {
            selectedIds = Set(data.rows.filter(\.selected).map(\.id))
            if hasSelection {
                onAction("selection_changed", ["selectedIds": AnyCodable(Array(selectedIds))])
            }
        }
        .coordinateSpace(name: resizeGestureCoordinateSpaceName)
        .onDisappear {
            activeResizeHandleIndex = nil
        }
    }

    // MARK: - Table Content

    @ViewBuilder
    private var tableContainer: some View {
        if needsHorizontalScroll {
            horizontalScrollableTable
        } else {
            tableContent
        }
    }

    private var horizontalScrollableTable: some View {
        ScrollView(.horizontal, showsIndicators: true) {
            tableContent
                .frame(width: minimumTableWidth, alignment: .leading)
        }
        .scrollDisabled(isResizingColumn)
        .frame(width: maxTableViewportWidth)
        .overlay(alignment: .trailing) {
            if shouldShowHorizontalHint {
                overflowHint
            }
        }
    }

    private var overflowHint: some View {
        LinearGradient(
            colors: [Color.clear, VColor.surfaceOverlay],
            startPoint: .leading,
            endPoint: .trailing
        )
        .frame(width: 28)
        .allowsHitTesting(false)
        .accessibilityHidden(true)
    }

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
                    .pointerCursor()
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
                            .lineLimit(nil)
                            .fixedSize(horizontal: false, vertical: true)

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
                    .pointerCursor()
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
        HStack(alignment: .top, spacing: VSpacing.xs) {
            if let icon = value?.icon,
               let vIcon = SFSymbolMapping.icon(forSFSymbol: icon) {
                VIconView(vIcon, size: 12)
                    .foregroundStyle(resolveIconColor(value?.iconColor))
            }
            Text(value?.text ?? "")
                .font(VFont.bodyMediumLighter)
                .foregroundStyle(VColor.contentDefault)
                .lineLimit(nil)
                .multilineTextAlignment(.leading)
                .fixedSize(horizontal: false, vertical: true)
                .textSelection(.enabled)
        }
        .padding(.trailing, VSpacing.xs)
    }

    // MARK: - Resize Handle

    private func resizeHandle(for columnIndex: Int) -> some View {
        let isHighlighted = isResizeHandleHighlighted(columnIndex)
        #if os(macOS)
        return Rectangle()
            .fill(Color.clear)
            .frame(width: resizeHandleWidth)
            .overlay(
                Rectangle()
                    .fill(resizeHandleIndicatorColor(isHighlighted: isHighlighted))
                    .frame(width: resizeHandleIndicatorWidth(isHighlighted: isHighlighted))
                    .opacity(resizeHandleIndicatorOpacity(isHighlighted: isHighlighted))
            )
            .overlay {
                HorizontalResizeHandleTrackingView(
                    isDragging: activeResizeHandleIndex == columnIndex,
                    onDragBegan: {
                        beginResize(for: columnIndex)
                    },
                    onDragChanged: { delta in
                        applyResizeDelta(delta, for: columnIndex)
                    },
                    onDragEnded: {
                        endResize(for: columnIndex)
                    }
                )
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            }
            .contentShape(Rectangle())
        #else
        return Rectangle()
            .fill(Color.clear)
            .frame(width: resizeHandleWidth)
            .overlay(
                Rectangle()
                    .fill(resizeHandleIndicatorColor(isHighlighted: isHighlighted))
                    .frame(width: resizeHandleIndicatorWidth(isHighlighted: isHighlighted))
                    .opacity(resizeHandleIndicatorOpacity(isHighlighted: isHighlighted))
            )
            .contentShape(Rectangle())
            .gesture(resizeHandleDragGesture(for: columnIndex))
        #endif
    }

    private func isResizeHandleHighlighted(_ columnIndex: Int) -> Bool {
        activeResizeHandleIndex == columnIndex
    }

    private func resizeHandleIndicatorOpacity(isHighlighted: Bool) -> Double {
        #if os(macOS)
        isHighlighted ? 1 : 0
        #else
        isHighlighted ? 1 : 0.2
        #endif
    }

    private func resizeHandleDragGesture(for columnIndex: Int) -> some Gesture {
        DragGesture(minimumDistance: 0, coordinateSpace: .named(resizeGestureCoordinateSpaceName))
            .onChanged { value in
                beginResize(for: columnIndex)
                #if os(macOS)
                NSCursor.resizeLeftRight.set()
                #endif
                let delta = value.location.x - value.startLocation.x
                applyResizeDelta(delta, for: columnIndex)
            }
            .onEnded { _ in
                endResize(for: columnIndex)
            }
    }

    private func beginResize(for columnIndex: Int) {
        let column = data.columns[columnIndex]
        if activeResizeHandleIndex == nil {
            activeResizeHandleIndex = columnIndex
        }
        if resizeDragStartWidths[column.id] == nil {
            resizeDragStartWidths[column.id] = currentColumnWidth(column)
        }
    }

    private func applyResizeDelta(_ delta: CGFloat, for columnIndex: Int) {
        let column = data.columns[columnIndex]
        guard let startWidth = resizeDragStartWidths[column.id] else { return }
        let newWidth = max(minColumnWidth, startWidth + delta)
        let snappedWidth = (newWidth * 2).rounded() / 2
        if columnOverrides[column.id] != snappedWidth {
            var transaction = Transaction()
            transaction.disablesAnimations = true
            withTransaction(transaction) {
                columnOverrides[column.id] = snappedWidth
            }
        }
    }

    private func endResize(for columnIndex: Int) {
        let column = data.columns[columnIndex]
        resizeDragStartWidths[column.id] = nil
        activeResizeHandleIndex = nil
        #if os(macOS)
        NSCursor.arrow.set()
        #endif
    }

    private func resizeHandleIndicatorWidth(isHighlighted: Bool) -> CGFloat {
        isHighlighted ? 2 : 1
    }

    private func resizeHandleIndicatorColor(isHighlighted: Bool) -> Color {
        isHighlighted ? VColor.primaryBase : VColor.borderBase.opacity(0.45)
    }

    private func currentColumnWidth(_ column: TableColumn) -> CGFloat {
        columnOverrides[column.id]
            ?? column.width.map { CGFloat($0) }
            ?? estimatedFlexWidth()
    }

    /// Estimate a flexible column's baseline width for drag start.
    private func estimatedFlexWidth() -> CGFloat {
        let checkboxWidth: CGFloat = hasSelection ? selectionColumnWidth : 0
        let fixedTotal = columnSpecs.compactMap { $0 }.reduce(0, +)
        let flexCount = columnSpecs.filter { $0 == nil }.count
        guard flexCount > 0 else { return minColumnWidth }
        return max(minColumnWidth, (maxTableViewportWidth - checkboxWidth - fixedTotal) / CGFloat(flexCount))
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

#if os(macOS)
private struct HorizontalResizeHandleTrackingView: NSViewRepresentable {
    let isDragging: Bool
    let onDragBegan: () -> Void
    let onDragChanged: (CGFloat) -> Void
    let onDragEnded: () -> Void

    final class Coordinator {
        var onDragBegan: () -> Void
        var onDragChanged: (CGFloat) -> Void
        var onDragEnded: () -> Void

        init(
            onDragBegan: @escaping () -> Void,
            onDragChanged: @escaping (CGFloat) -> Void,
            onDragEnded: @escaping () -> Void
        ) {
            self.onDragBegan = onDragBegan
            self.onDragChanged = onDragChanged
            self.onDragEnded = onDragEnded
        }
    }

    func makeCoordinator() -> Coordinator {
        Coordinator(
            onDragBegan: onDragBegan,
            onDragChanged: onDragChanged,
            onDragEnded: onDragEnded
        )
    }

    func makeNSView(context: Context) -> HorizontalResizeHandleTrackingNSView {
        let view = HorizontalResizeHandleTrackingNSView()
        view.onDragBegan = {
            context.coordinator.onDragBegan()
        }
        view.onDragChanged = { delta in
            context.coordinator.onDragChanged(delta)
        }
        view.onDragEnded = {
            context.coordinator.onDragEnded()
        }
        return view
    }

    func updateNSView(_ nsView: HorizontalResizeHandleTrackingNSView, context: Context) {
        context.coordinator.onDragBegan = onDragBegan
        context.coordinator.onDragChanged = onDragChanged
        context.coordinator.onDragEnded = onDragEnded
        nsView.onDragBegan = {
            context.coordinator.onDragBegan()
        }
        nsView.onDragChanged = { delta in
            context.coordinator.onDragChanged(delta)
        }
        nsView.onDragEnded = {
            context.coordinator.onDragEnded()
        }
        nsView.isDragging = isDragging
        nsView.window?.invalidateCursorRects(for: nsView)
        if isDragging {
            NSCursor.resizeLeftRight.set()
        }
    }
}

private final class HorizontalResizeHandleTrackingNSView: NSView {
    var onDragBegan: (() -> Void)?
    var onDragChanged: ((CGFloat) -> Void)?
    var onDragEnded: (() -> Void)?
    var isDragging: Bool = false
    private var trackingAreaRef: NSTrackingArea?
    private var dragStartXInWindow: CGFloat?

    override func viewDidMoveToWindow() {
        super.viewDidMoveToWindow()
        window?.invalidateCursorRects(for: self)
    }

    override func updateTrackingAreas() {
        if let trackingAreaRef {
            removeTrackingArea(trackingAreaRef)
        }
        let options: NSTrackingArea.Options = [
            .activeInKeyWindow,
            .enabledDuringMouseDrag,
            .inVisibleRect,
            .cursorUpdate
        ]
        let area = NSTrackingArea(rect: .zero, options: options, owner: self, userInfo: nil)
        addTrackingArea(area)
        trackingAreaRef = area
        super.updateTrackingAreas()
    }

    override func resetCursorRects() {
        addCursorRect(bounds, cursor: .resizeLeftRight)
    }

    override func cursorUpdate(with event: NSEvent) {
        NSCursor.resizeLeftRight.set()
    }

    override func hitTest(_ point: NSPoint) -> NSView? {
        self
    }

    override func mouseDown(with event: NSEvent) {
        dragStartXInWindow = event.locationInWindow.x
        onDragBegan?()
        NSCursor.resizeLeftRight.set()
    }

    override func mouseDragged(with event: NSEvent) {
        guard let dragStartXInWindow else { return }
        let delta = event.locationInWindow.x - dragStartXInWindow
        onDragChanged?(delta)
        NSCursor.resizeLeftRight.set()
    }

    override func mouseUp(with event: NSEvent) {
        if let dragStartXInWindow {
            let delta = event.locationInWindow.x - dragStartXInWindow
            onDragChanged?(delta)
        }
        dragStartXInWindow = nil
        onDragEnded?()
    }
}
#endif
