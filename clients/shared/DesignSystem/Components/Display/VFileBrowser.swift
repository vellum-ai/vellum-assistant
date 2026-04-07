#if os(macOS)
import SwiftUI

// MARK: - File Browser Node Model

/// A navigation-only node in the `VFileBrowser` tree. This model is intentionally
/// content-free: it does NOT carry file content, mimeType, or `isBinary`. The right
/// pane content is always rendered by the caller via the `contentPane` closure, so
/// the design system component never needs to know about file payloads.
public struct VFileBrowserNode: Identifiable, Hashable {
    public let id: String
    public let name: String
    public let path: String
    public let isDirectory: Bool
    public let size: Int?           // nil for directories
    public let icon: VIcon          // icon for files; directories always render as VIcon.folder
    public var isDimmed: Bool       // for hidden files in the Workspace tab
    public var children: [VFileBrowserNode]  // empty for leaves; may also be empty for not-yet-loaded folders in lazy mode

    public init(
        id: String,
        name: String,
        path: String,
        isDirectory: Bool,
        size: Int? = nil,
        icon: VIcon = .fileText,
        isDimmed: Bool = false,
        children: [VFileBrowserNode] = []
    ) {
        self.id = id
        self.name = name
        self.path = path
        self.isDirectory = isDirectory
        self.size = size
        self.icon = icon
        self.isDimmed = isDimmed
        self.children = children
    }
}

// MARK: - VFileBrowser

/// A two-pane file browser with a tree-based file list on the left and
/// caller-provided content on the right. Both panes use bordered card
/// styling matching the Figma spec.
///
/// The sidebar contains (top to bottom): a header row with a title and
/// a trailing actions slot, a divider, a search bar (with auto-expand of
/// matching parents), a scrollable tree, and an optional pinned footer
/// (e.g. for upload progress). An optional gutter slot renders between
/// the sidebar card and the right pane — callers use it to host a
/// resize handle when the sidebar width is user-adjustable.
///
/// The right pane content is provided via a `@ViewBuilder` closure so
/// callers in the macOS target can pass `FileContentView` (which lives
/// in VellumAssistantLib, not the shared module).
public struct VFileBrowser<
    HeaderActions: View,
    RowContextMenu: View,
    ContentPane: View,
    SidebarTrailingGutter: View,
    SidebarFooter: View
>: View {
    let title: String
    let rootNodes: [VFileBrowserNode]
    @Binding var expandedPaths: Set<String>
    @Binding var selectedPath: String?
    let searchPlaceholder: String
    let sidebarWidth: CGFloat
    let onExpand: ((VFileBrowserNode) async -> Void)?
    let onSelect: ((VFileBrowserNode) -> Void)?
    let onDrop: ((VFileBrowserNode?, [NSItemProvider]) -> Bool)?
    let headerActions: () -> HeaderActions
    let rowContextMenu: (VFileBrowserNode) -> RowContextMenu
    let contentPane: (VFileBrowserNode?) -> ContentPane
    let sidebarTrailingGutter: () -> SidebarTrailingGutter
    let sidebarFooter: () -> SidebarFooter

    @State private var searchText: String = ""
    @State private var isDropTargeted: Bool = false

    public init(
        title: String = "Files",
        rootNodes: [VFileBrowserNode],
        expandedPaths: Binding<Set<String>>,
        selectedPath: Binding<String?>,
        searchPlaceholder: String = "Search files",
        sidebarWidth: CGFloat = 280,
        onExpand: ((VFileBrowserNode) async -> Void)? = nil,
        onSelect: ((VFileBrowserNode) -> Void)? = nil,
        onDrop: ((VFileBrowserNode?, [NSItemProvider]) -> Bool)? = nil,
        @ViewBuilder headerActions: @escaping () -> HeaderActions = { EmptyView() },
        @ViewBuilder rowContextMenu: @escaping (VFileBrowserNode) -> RowContextMenu = { _ in EmptyView() },
        @ViewBuilder contentPane: @escaping (VFileBrowserNode?) -> ContentPane,
        @ViewBuilder sidebarTrailingGutter: @escaping () -> SidebarTrailingGutter = { VFileBrowserDefaultSidebarGutter() },
        @ViewBuilder sidebarFooter: @escaping () -> SidebarFooter = { EmptyView() }
    ) {
        self.title = title
        self.rootNodes = rootNodes
        self._expandedPaths = expandedPaths
        self._selectedPath = selectedPath
        self.searchPlaceholder = searchPlaceholder
        self.sidebarWidth = sidebarWidth
        self.onExpand = onExpand
        self.onSelect = onSelect
        self.onDrop = onDrop
        self.headerActions = headerActions
        self.rowContextMenu = rowContextMenu
        self.contentPane = contentPane
        self.sidebarTrailingGutter = sidebarTrailingGutter
        self.sidebarFooter = sidebarFooter
    }

    // MARK: - Body

    public var body: some View {
        // HStack spacing is 0 because the gutter defines its own width.
        // The default `VFileBrowserDefaultSidebarGutter` is a `VSpacing.sm`-wide clear
        // spacer that preserves the original layout for callers that don't
        // supply a custom gutter (e.g. Skills).
        HStack(spacing: 0) {
            sidebarPane
            sidebarTrailingGutter()
            rightPane
        }
    }

    // MARK: - Selection lookup

    private var selectedNode: VFileBrowserNode? {
        guard let path = selectedPath else { return nil }
        return findNode(in: rootNodes, withPath: path)
    }

    private func findNode(in nodes: [VFileBrowserNode], withPath path: String) -> VFileBrowserNode? {
        for node in nodes {
            if node.path == path { return node }
            if node.isDirectory, let match = findNode(in: node.children, withPath: path) {
                return match
            }
        }
        return nil
    }

    // MARK: - Sidebar Pane

    private var sidebarPane: some View {
        VStack(spacing: 0) {
            // Header row: title + trailing actions slot
            HStack(spacing: VSpacing.sm) {
                Text(title)
                    .font(VFont.bodySmallEmphasised)
                    .foregroundStyle(VColor.contentDefault)
                Spacer()
                headerActions()
            }
            .padding(EdgeInsets(top: VSpacing.sm, leading: VSpacing.md, bottom: VSpacing.sm, trailing: VSpacing.md))

            Divider()
                .background(VColor.borderBase)

            // Search bar BELOW the divider
            VSearchBar(placeholder: searchPlaceholder, text: $searchText)
                .padding(EdgeInsets(top: VSpacing.xs, leading: VSpacing.md, bottom: VSpacing.xs, trailing: VSpacing.md))

            // Scrollable tree
            treeScrollView

            // Pinned footer (e.g. upload progress). Does NOT scroll with the tree.
            sidebarFooter()
        }
        .frame(width: sidebarWidth)
        .background(VColor.surfaceLift)
        .clipShape(RoundedRectangle(cornerRadius: VRadius.xl))
        .overlay(
            RoundedRectangle(cornerRadius: VRadius.xl)
                .strokeBorder(VColor.borderHover, lineWidth: 1)
        )
        .overlay {
            if onDrop != nil && isDropTargeted {
                RoundedRectangle(cornerRadius: VRadius.xl)
                    .strokeBorder(VColor.primaryBase, style: StrokeStyle(lineWidth: 2, dash: [6, 3]))
                    .padding(4)
                    .allowsHitTesting(false)
            }
        }
    }

    private var treeScrollView: some View {
        let data = visibleRowData
        return ScrollView {
            LazyVStack(spacing: 0) {
                ForEach(data.rows, id: \.node.path) { row in
                    VFileBrowserTreeRow(
                        node: row.node,
                        depth: row.depth,
                        isSelected: selectedPath == row.node.path,
                        isExpanded: expandedPaths.contains(row.node.path) || data.forcedExpanded.contains(row.node.path),
                        onTap: { handleTap(row.node) },
                        rowContextMenu: rowContextMenu,
                        onDrop: onDrop
                    )
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.vertical, VSpacing.xs)
        }
        .background(rootDropTarget)
    }

    @ViewBuilder
    private var rootDropTarget: some View {
        if let onDrop {
            Color.clear
                .contentShape(Rectangle())
                .onDrop(of: [.fileURL], isTargeted: $isDropTargeted) { providers in
                    onDrop(nil, providers)
                }
        } else {
            Color.clear
        }
    }

    // MARK: - Right Pane

    private var rightPane: some View {
        contentPane(selectedNode)
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .background(VColor.surfaceLift)
            .clipShape(RoundedRectangle(cornerRadius: VRadius.xl))
            .overlay(
                RoundedRectangle(cornerRadius: VRadius.xl)
                    .strokeBorder(VColor.borderHover, lineWidth: 1)
            )
    }

    // MARK: - Tap handler

    private func handleTap(_ node: VFileBrowserNode) {
        if node.isDirectory {
            let wasExpanded = expandedPaths.contains(node.path)
            withAnimation(VAnimation.fast) {
                if wasExpanded {
                    expandedPaths.remove(node.path)
                } else {
                    expandedPaths.insert(node.path)
                }
            }
            if !wasExpanded, let onExpand {
                Task { await onExpand(node) }
            }
        } else {
            // Already-selected guard: no-op if the file is already selected so
            // callers don't see spurious taps (e.g. a dirty-alert re-prompt for
            // the same file).
            if selectedPath == node.path { return }
            if let onSelect {
                // Caller owns selection — they'll update `selectedPath` if they
                // want to. This lets callers veto the selection (e.g. when the
                // current file has unsaved changes and the user cancels the
                // dirty alert).
                onSelect(node)
            } else {
                // No caller callback — auto-select for convenience-initializer
                // callers (e.g. Skills) that rely on the browser to manage
                // selection on its own.
                selectedPath = node.path
            }
        }
    }

    // MARK: - Tree flattening / search

    private struct VisibleRowData {
        let rows: [(node: VFileBrowserNode, depth: Int)]
        let forcedExpanded: Set<String>
    }

    /// When search is active, the tree is filtered to matches and their ancestors,
    /// and ALL ancestor directories are forcibly rendered as expanded regardless of
    /// `expandedPaths`. This means clicking a directory during search appears to do
    /// nothing — a deliberate UX choice so users always see the matches.
    private var visibleRowData: VisibleRowData {
        if searchText.isEmpty {
            let rows = Self.flattenTree(rootNodes, depth: 0, expanded: expandedPaths)
            return VisibleRowData(rows: rows, forcedExpanded: [])
        }
        let result = Self.filterTreeForSearch(rootNodes, query: searchText)
        let rows = Self.flattenTree(result.nodes, depth: 0, expanded: result.forcedExpanded)
        return VisibleRowData(rows: rows, forcedExpanded: result.forcedExpanded)
    }

    private static func flattenTree(
        _ nodes: [VFileBrowserNode],
        depth: Int,
        expanded: Set<String>
    ) -> [(node: VFileBrowserNode, depth: Int)] {
        var result: [(VFileBrowserNode, Int)] = []
        for node in nodes {
            result.append((node, depth))
            if node.isDirectory && expanded.contains(node.path) {
                result.append(contentsOf: flattenTree(node.children, depth: depth + 1, expanded: expanded))
            }
        }
        return result
    }

    private struct SearchResult {
        let nodes: [VFileBrowserNode]      // tree pruned to matches + ancestors
        let forcedExpanded: Set<String>    // every ancestor of every match
    }

    private static func filterTreeForSearch(_ nodes: [VFileBrowserNode], query: String) -> SearchResult {
        var forcedExpanded: Set<String> = []
        func filter(_ nodes: [VFileBrowserNode]) -> [VFileBrowserNode] {
            return nodes.compactMap { node in
                let nameMatches = node.name.localizedCaseInsensitiveContains(query)
                if !node.isDirectory {
                    return nameMatches ? node : nil
                }
                let filteredChildren = filter(node.children)
                if nameMatches || !filteredChildren.isEmpty {
                    forcedExpanded.insert(node.path)
                    var copy = node
                    copy.children = filteredChildren
                    return copy
                }
                return nil
            }
        }
        let filtered = filter(nodes)
        return SearchResult(nodes: filtered, forcedExpanded: forcedExpanded)
    }
}

// MARK: - Default sidebar gutter

/// The default sidebar trailing gutter: a `VSpacing.sm`-wide clear spacer that
/// preserves the original horizontal gap between the sidebar and the right pane
/// for callers that do not supply a custom gutter view.
public struct VFileBrowserDefaultSidebarGutter: View {
    public init() {}

    public var body: some View {
        Color.clear.frame(width: VSpacing.sm)
    }
}

// MARK: - Convenience overload (no header actions, no row context menu)

extension VFileBrowser
where
    HeaderActions == EmptyView,
    RowContextMenu == EmptyView,
    SidebarTrailingGutter == VFileBrowserDefaultSidebarGutter,
    SidebarFooter == EmptyView
{
    /// Convenience initializer for callers that don't need a header actions slot
    /// or per-row context menus. Provided as a non-defaulted overload so callers
    /// only need to supply `contentPane`.
    public init(
        title: String = "Files",
        rootNodes: [VFileBrowserNode],
        expandedPaths: Binding<Set<String>>,
        selectedPath: Binding<String?>,
        searchPlaceholder: String = "Search files",
        sidebarWidth: CGFloat = 280,
        onExpand: ((VFileBrowserNode) async -> Void)? = nil,
        onSelect: ((VFileBrowserNode) -> Void)? = nil,
        onDrop: ((VFileBrowserNode?, [NSItemProvider]) -> Bool)? = nil,
        @ViewBuilder contentPane: @escaping (VFileBrowserNode?) -> ContentPane
    ) {
        self.init(
            title: title,
            rootNodes: rootNodes,
            expandedPaths: expandedPaths,
            selectedPath: selectedPath,
            searchPlaceholder: searchPlaceholder,
            sidebarWidth: sidebarWidth,
            onExpand: onExpand,
            onSelect: onSelect,
            onDrop: onDrop,
            headerActions: { EmptyView() },
            rowContextMenu: { _ in EmptyView() },
            contentPane: contentPane,
            sidebarTrailingGutter: { VFileBrowserDefaultSidebarGutter() },
            sidebarFooter: { EmptyView() }
        )
    }
}

// MARK: - Tree Row
//
// Visual contract (must remain stable across design-system consumers):
// - 12pt chevron at a fixed 12pt-wide leading position
// - 12pt folder/file icon
// - `VFont.bodyMediumDefault` name
// - `VFont.labelDefault` / `VColor.contentTertiary` trailing size
// - `CGFloat(depth) * VSpacing.lg + VSpacing.sm` leading padding,
//   `VSpacing.sm` trailing padding, `VSpacing.xs` vertical padding.

private struct VFileBrowserTreeRow<RowContextMenu: View>: View {
    let node: VFileBrowserNode
    let depth: Int
    let isSelected: Bool
    let isExpanded: Bool
    let onTap: () -> Void
    let rowContextMenu: (VFileBrowserNode) -> RowContextMenu
    let onDrop: ((VFileBrowserNode?, [NSItemProvider]) -> Bool)?

    @State private var isDropTargeted = false

    var body: some View {
        Button(action: onTap) {
            HStack(spacing: VSpacing.xs) {
                // Expand/collapse chevron for directories, spacer for files
                if node.isDirectory {
                    VIconView(isExpanded ? .chevronDown : .chevronRight, size: 9)
                        .foregroundStyle(VColor.contentTertiary)
                        .frame(width: 12)
                } else {
                    Spacer().frame(width: 12)
                }

                // File or folder icon
                VIconView(node.isDirectory ? .folder : node.icon, size: 12)
                    .foregroundStyle(isSelected ? VColor.primaryActive : VColor.primaryBase)

                // Name label
                Text(node.name)
                    .font(VFont.bodyMediumDefault)
                    .foregroundStyle(
                        node.isDimmed ? VColor.contentTertiary :
                        isSelected ? VColor.contentEmphasized :
                        VColor.contentSecondary
                    )
                    .lineLimit(1)
                    .truncationMode(.middle)

                Spacer(minLength: VSpacing.sm)

                // Trailing size for files only
                if !node.isDirectory, let size = node.size {
                    Text(formatFileSize(size))
                        .font(VFont.labelDefault)
                        .foregroundStyle(VColor.contentTertiary)
                }
            }
            .padding(EdgeInsets(
                top: VSpacing.xs,
                leading: CGFloat(depth) * VSpacing.lg + VSpacing.sm,
                bottom: VSpacing.xs,
                trailing: VSpacing.sm
            ))
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(
                RoundedRectangle(cornerRadius: VRadius.sm)
                    .fill(isSelected ? VColor.surfaceActive : (isDropTargeted ? VColor.surfaceBase : Color.clear))
            )
            .opacity(node.isDimmed ? 0.6 : 1.0)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .pointerCursor()
        .accessibilityLabel(node.name)
        .accessibilityHint(
            isSelected ? "Selected"
            : (node.isDirectory ? "Tap to \(isExpanded ? "collapse" : "expand")" : "Tap to select")
        )
        .contextMenu { rowContextMenu(node) }
        .modifier(DropTargetModifier(node: node, isTargeted: $isDropTargeted, onDrop: onDrop))
    }
}

/// Conditionally attaches an `.onDrop` handler to a row when both the node is
/// a directory and an `onDrop` callback is provided. Files and rows without an
/// `onDrop` callback are no-ops.
private struct DropTargetModifier: ViewModifier {
    let node: VFileBrowserNode
    @Binding var isTargeted: Bool
    let onDrop: ((VFileBrowserNode?, [NSItemProvider]) -> Bool)?

    func body(content: Content) -> some View {
        if node.isDirectory, let onDrop {
            content.onDrop(of: [.fileURL], isTargeted: $isTargeted) { providers in
                onDrop(node, providers)
            }
        } else {
            content
        }
    }
}

#endif
