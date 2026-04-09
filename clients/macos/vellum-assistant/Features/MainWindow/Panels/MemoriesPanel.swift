import SwiftUI
import VellumAssistantShared

// MARK: - Sort Options

private enum MemorySortOption: String, CaseIterable {
    case newest = "Newest"
    case oldest = "Oldest"
    case importance = "Importance"
    case kind = "Kind"

    var sortField: String {
        switch self {
        case .newest, .oldest: return "lastSeenAt"
        case .importance: return "importance"
        case .kind: return "kind"
        }
    }

    var sortOrder: String {
        switch self {
        case .newest, .importance: return "desc"
        case .oldest, .kind: return "asc"
        }
    }

    var icon: VIcon {
        switch self {
        case .newest: return .arrowDown
        case .oldest: return .arrowUp
        case .importance: return .star
        case .kind: return .tag
        }
    }
}

private enum MemoryStatusFilter: String, CaseIterable {
    case active = "Active"
    case inactive = "Inactive"
    case all = "All"

    /// API value sent as the `status` query parameter.
    var apiValue: String {
        switch self {
        case .active: return "active"
        case .inactive: return "inactive"
        case .all: return "all"
        }
    }

    var icon: VIcon {
        switch self {
        case .active: return .circleCheck
        case .inactive: return .circleDashed
        case .all: return .circle
        }
    }

    var accessibilityDescription: String {
        switch self {
        case .active: return "Show currently referenced memories"
        case .inactive: return "Show archived or superseded memories"
        case .all: return "Show all memories including inactive"
        }
    }
}

// MARK: - Memories Panel

struct MemoriesPanel: View {
    let connectionManager: GatewayConnectionManager
    let assistantName: String
    var onImportMemory: ((String) -> Void)?
    @Binding var focusedMemoryId: String?
    @State private var store: MemoryItemsStore
    @State private var showImportSheet = false
    @State private var selectedItem: MemoryItemPayload?
    @State private var selectedKind: MemoryKind?
    @State private var statusFilter: MemoryStatusFilter = .active
    @State private var sortOption: MemorySortOption = .newest
    @State private var searchDebounceTask: Task<Void, Never>?
    init(connectionManager: GatewayConnectionManager, assistantName: String = "Your Assistant", onImportMemory: ((String) -> Void)? = nil, focusedMemoryId: Binding<String?> = .constant(nil)) {
        self.connectionManager = connectionManager
        self.assistantName = assistantName
        self.onImportMemory = onImportMemory
        _focusedMemoryId = focusedMemoryId
        _store = State(wrappedValue: MemoryItemsStore(memoryItemClient: MemoryItemClient()))
    }

    /// Kinds to show in the sidebar filter. Excludes system-managed kinds.
    private static let filterableKinds: [MemoryKind] = MemoryKind.userCreatableKinds

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            // Memory count header
            HStack(alignment: .firstTextBaseline, spacing: VSpacing.sm) {
                Text("\(store.total)")
                    .font(VFont.titleLarge)
                    .foregroundStyle(VColor.contentEmphasized)
                Text(store.total == 1 ? "memory" : "memories")
                    .font(VFont.bodyMediumLighter)
                    .foregroundStyle(VColor.contentTertiary)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.bottom, VSpacing.xs)

            filterBar

            // Active filter pills
            let hasActiveFilters = selectedKind != nil || statusFilter != .active || !store.searchText.isEmpty
            if hasActiveFilters {
                HStack(spacing: VSpacing.xs) {
                    if let kind = selectedKind {
                        filterPill(label: kind.label, color: kind.color) {
                            withAnimation(VAnimation.fast) { selectedKind = nil }
                            store.kindFilter = nil
                            Task { await store.loadItems() }
                        }
                    }
                    if statusFilter != .active {
                        filterPill(label: statusFilter.rawValue, color: VColor.contentSecondary) {
                            statusFilter = .active
                            store.statusFilter = statusFilter.apiValue
                            Task { await store.loadItems() }
                        }
                    }
                    if !store.searchText.isEmpty {
                        filterPill(label: "\"\(store.searchText)\"", color: VColor.contentSecondary) {
                            store.searchText = ""
                        }
                    }
                }
                .padding(.top, VSpacing.xs)
            }

            HStack(alignment: .top, spacing: VSpacing.xxl) {
                kindSidebar
                    .frame(width: 220)

                HStack(spacing: 0) {
                    // Memory list — takes remaining width
                    listContent
                        .frame(maxWidth: .infinity)

                    // Side detail panel — slides in from right
                    if let item = selectedItem {
                        Divider()
                        MemoryItemDetailSheet(
                            item: item,
                            store: store,
                            onDismiss: { withAnimation(VAnimation.panel) { selectedItem = nil } },
                            onNavigate: { newItem in
                                withAnimation(VAnimation.fast) { selectedItem = newItem }
                            }
                        )
                        .id(item.id)
                        .frame(width: 400)
                        .frame(maxHeight: .infinity)
                        .transition(.move(edge: .trailing).combined(with: .opacity))
                        .onKeyPress(.escape) {
                            withAnimation(VAnimation.panel) { selectedItem = nil }
                            return .handled
                        }
                    }
                }
                .animation(VAnimation.panel, value: selectedItem?.id)
            }
            .padding(.top, VSpacing.lg)
        }
        .task { await store.loadItems() }
        .task(id: focusedMemoryId) {
            guard let memoryId = focusedMemoryId else { return }
            if let item = await store.fetchDetail(id: memoryId) {
                withAnimation(VAnimation.panel) { selectedItem = item }
            }
            focusedMemoryId = nil
        }
        .onDisappear {
            searchDebounceTask?.cancel()
            searchDebounceTask = nil
        }
        .sheet(isPresented: $showImportSheet) {
            MemoryImportSheet(
                assistantName: assistantName,
                onDismiss: { showImportSheet = false },
                onSubmit: onImportMemory.map { callback in
                    { pastedText in
                        let wrappedMessage = """
                            The following is a memory profile exported from another AI assistant. Please review it and internalize the information as memories about me. Treat each fact, preference, and detail as something to remember for future conversations.

                            ---

                            \(pastedText)
                            """
                        callback(wrappedMessage)
                    }
                }
            )
        }
    }

    // MARK: - Filter Bar

    @ViewBuilder
    private var filterBar: some View {
        HStack(spacing: VSpacing.sm) {
            VSearchBar(placeholder: "Search Memories", text: $store.searchText)
                .onChange(of: store.searchText) {
                    searchDebounceTask?.cancel()
                    searchDebounceTask = Task {
                        try? await Task.sleep(nanoseconds: 300_000_000)
                        guard !Task.isCancelled else { return }
                        await store.loadItems()
                    }
                }

            VDropdown(
                options: MemoryStatusFilter.allCases.map { VDropdownOption(label: $0.rawValue, value: $0, icon: $0.icon) },
                selection: $statusFilter,
                maxWidth: 158,
                onChange: { newStatus in
                    store.statusFilter = newStatus.apiValue
                    Task { await store.loadItems() }
                }
            )
            .accessibilityHint(statusFilter.accessibilityDescription)

            VDropdown(
                options: MemorySortOption.allCases.map { VDropdownOption(label: $0.rawValue, value: $0, icon: $0.icon) },
                selection: $sortOption,
                maxWidth: 158,
                onChange: { newSort in
                    store.sortField = newSort.sortField
                    store.sortOrder = newSort.sortOrder
                    Task { await store.loadItems() }
                }
            )

            VButton(label: "Import", icon: VIcon.arrowDownToLine.rawValue, style: .primary) {
                showImportSheet = true
            }
            .accessibilityLabel("Import memory")
        }
        .padding(.top, VSpacing.sm)
    }

    // MARK: - Kind Sidebar

    private var kindSidebar: some View {
        VStack(alignment: .leading, spacing: VSpacing.xs) {
            kindFilterRow(icon: VIcon.layoutGrid.rawValue, label: "All", kind: nil)
            ForEach(Self.filterableKinds) { kind in
                kindFilterRow(icon: kind.icon, label: kind.label, kind: kind)
            }
        }
    }

    private func kindFilterRow(icon: String, label: String, kind: MemoryKind?) -> some View {
        KindFilterRowButton(
            icon: icon,
            label: label,
            kind: kind,
            isActive: selectedKind == kind,
            count: kindCount(for: kind),
            action: {
                withAnimation(VAnimation.fast) { selectedKind = kind }
                store.kindFilter = kind?.rawValue
                Task { await store.loadItems() }
            }
        )
    }

    private func kindCount(for kind: MemoryKind?) -> Int {
        guard let kind else {
            return store.kindCounts.values.reduce(0, +)
        }
        return store.kindCounts[kind.rawValue] ?? 0
    }

    // MARK: - Filter Pill

    private func filterPill(label: String, color: Color, onRemove: @escaping () -> Void) -> some View {
        HStack(spacing: VSpacing.xxs) {
            Text(label)
                .font(VFont.labelDefault)
                .foregroundStyle(color)
            Button(action: onRemove) {
                VIconView(.x, size: 9)
                    .foregroundStyle(VColor.contentTertiary)
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Remove \(label) filter")
        }
        .padding(.horizontal, VSpacing.sm)
        .padding(.vertical, VSpacing.xxs)
        .background(color.opacity(0.1))
        .clipShape(Capsule())
    }

    // MARK: - List Content

    @ViewBuilder
    private var listContent: some View {
        if store.isLoading && store.items.isEmpty {
            VStack {
                Spacer()
                VLoadingIndicator()
                Spacer()
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        } else if store.items.isEmpty {
            VEmptyState(
                title: selectedKind == nil ? "No Memories Yet" : "No \(selectedKind!.label) Memories",
                subtitle: selectedKind == nil
                    ? "Your assistant learns and remembers things from your conversations. Memories will appear here as they're created."
                    : "Try selecting a different kind or clearing the filter.",
                icon: VIcon.bookOpen.rawValue
            )
        } else {
            ScrollView {
                LazyVStack(spacing: VSpacing.sm) {
                    ForEach(store.items) { item in
                        MemoryItemRow(
                            item: item,
                            onSelect: { withAnimation(VAnimation.panel) { selectedItem = item } },
                            onDelete: {
                                if selectedItem?.id == item.id {
                                    withAnimation(VAnimation.panel) { selectedItem = nil }
                                }
                                Task { _ = await store.deleteItem(id: item.id) }
                            }
                        )
                    }
                    if store.hasMore {
                        VLoadingIndicator()
                            .frame(maxWidth: .infinity)
                            .padding(.vertical, VSpacing.md)
                            .onAppear {
                                guard !store.isLoading else { return }
                                Task { await store.loadMore() }
                            }
                    }
                }
                .background { OverlayScrollerStyle() }
            }
            .scrollContentBackground(.hidden)
        }
    }
}

// MARK: - Kind Filter Row Button

/// Custom sidebar row that adds a color-coded dot and kind-tinted active background.
private struct KindFilterRowButton: View {
    let icon: String
    let label: String
    let kind: MemoryKind?
    let isActive: Bool
    let count: Int
    let action: () -> Void

    @State private var isHovered = false

    private var dotColor: Color {
        kind?.color ?? VColor.contentTertiary
    }

    private var activeBackground: Color {
        kind?.backgroundTint ?? VColor.surfaceActive
    }

    private var iconColor: Color {
        isActive ? VColor.primaryActive : VColor.primaryBase
    }

    private var textColor: Color {
        isActive ? VColor.contentEmphasized : VColor.contentSecondary
    }

    var body: some View {
        HStack(spacing: VSpacing.xs) {
            Circle()
                .fill(dotColor)
                .frame(width: 8, height: 8)

            VIconView(.resolve(icon), size: VSize.iconDefault)
                .foregroundStyle(iconColor)
                .frame(width: VSize.iconSlot, height: VSize.iconSlot)

            Text(label)
                .font(VFont.bodyMediumDefault)
                .foregroundStyle(textColor)
                .lineLimit(1)
                .truncationMode(.tail)

            Spacer()

            Text("\(count)")
                .font(VFont.labelDefault)
                .foregroundStyle(VColor.contentTertiary)
        }
        .padding(.leading, VSpacing.xs)
        .padding(.trailing, VSpacing.sm)
        .padding(.vertical, VSpacing.xs)
        .frame(minHeight: VSize.rowMinHeight)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(
            isActive ? activeBackground :
            isHovered ? VColor.surfaceBase :
            Color.clear
        )
        .animation(VAnimation.fast, value: isHovered)
        .clipShape(RoundedRectangle(cornerRadius: VRadius.md))
        .contentShape(Rectangle())
        .onTapGesture { action() }
        .pointerCursor(onHover: { isHovered = $0 })
        .accessibilityLabel("\(label) filter")
        .accessibilityAddTraits(isActive ? .isSelected : [])
    }
}
