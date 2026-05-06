import SwiftUI
import VellumAssistantShared

// MARK: - Sort Options

private enum MemoryV2SortOption: String, CaseIterable {
    case recent = "Recent"
    case alphabetical = "A-Z"

    var icon: VIcon {
        switch self {
        case .recent: return .clock
        case .alphabetical: return .arrowDown
        }
    }
}

// MARK: - Memories V2 Panel

/// Browse-able list of memory v2 concept pages. Renders a sorted list of
/// concept-page summaries (slug, body size, edge count) loaded via
/// `MemoryV2Client`. Selecting a row opens a slide-in detail pane on the
/// right that lazy-loads and renders the page's raw markdown body via
/// `ConceptPageContentView` (the same component used by the per-message
/// activation-log inspector). Replaces `MemoriesPanel` when
/// `memory-v2-enabled` is on — wired in by the IntelligencePanel flag-gate
/// (PR 6 of the plan).
struct MemoriesV2Panel: View {
    @State private var pages: [MemoryV2ConceptPageSummary] = []
    @State private var isLoading: Bool = true
    @State private var v2Disabled: Bool = false
    @State private var selectedSlug: String?
    @State private var searchText: String = ""
    @State private var debouncedSearchText: String = ""
    @State private var sortOption: MemoryV2SortOption = .recent
    @State private var searchDebounceTask: Task<Void, Never>?

    private let client: MemoryV2ClientProtocol

    init(client: MemoryV2ClientProtocol = MemoryV2Client()) {
        self.client = client
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            filterBar

            HStack(spacing: 0) {
                listContent
                    .frame(maxWidth: .infinity)

                if let slug = selectedSlug {
                    Divider()
                    ConceptPageContentView(
                        slug: slug,
                        onDismiss: { withAnimation(VAnimation.panel) { selectedSlug = nil } }
                    )
                    .id(slug)
                    .frame(width: 400)
                    .frame(maxHeight: .infinity)
                    .transition(.move(edge: .trailing).combined(with: .opacity))
                    .onKeyPress(.escape) {
                        withAnimation(VAnimation.panel) { selectedSlug = nil }
                        return .handled
                    }
                }
            }
            .animation(VAnimation.panel, value: selectedSlug)
        }
        .padding(.top, VSpacing.lg)
        .task { await loadPages() }
        .onDisappear {
            searchDebounceTask?.cancel()
            searchDebounceTask = nil
        }
    }

    // MARK: - Filter Bar

    @ViewBuilder
    private var filterBar: some View {
        HStack(spacing: VSpacing.sm) {
            VSearchBar(placeholder: "Search Concept Pages", text: $searchText)
                .onChange(of: searchText) {
                    searchDebounceTask?.cancel()
                    searchDebounceTask = Task { @MainActor in
                        try? await Task.sleep(nanoseconds: 300_000_000)
                        guard !Task.isCancelled else { return }
                        debouncedSearchText = searchText
                    }
                }

            VDropdown(
                options: MemoryV2SortOption.allCases.map { VDropdownOption(label: $0.rawValue, value: $0, icon: $0.icon) },
                selection: $sortOption,
                maxWidth: 158
            )
        }
        .padding(.bottom, VSpacing.sm)
    }

    // MARK: - Derived View Data

    private var displayedPages: [MemoryV2ConceptPageSummary] {
        let filtered = debouncedSearchText.isEmpty
            ? pages
            : pages.filter { $0.slug.localizedCaseInsensitiveContains(debouncedSearchText) }
        switch sortOption {
        case .recent:
            return filtered.sorted { $0.updatedAtMs > $1.updatedAtMs }
        case .alphabetical:
            return filtered.sorted { $0.slug < $1.slug }
        }
    }

    // MARK: - List Content

    @ViewBuilder
    private var listContent: some View {
        if isLoading {
            ZStack {
                Color.clear
                VLoadingIndicator()
            }
        } else if v2Disabled {
            VEmptyState(
                title: "Memories are disabled",
                subtitle: "Enable memory in your workspace config to use this tab.",
                icon: VIcon.brain.rawValue
            )
        } else if pages.isEmpty {
            VEmptyState(
                title: "No memories yet",
                subtitle: "Your assistant builds concept pages as it reflects on your conversations. Check back after a few chats.",
                icon: VIcon.brain.rawValue
            )
        } else if displayedPages.isEmpty {
            VEmptyState(
                title: "No matching concept pages",
                subtitle: "Try a different search term.",
                icon: VIcon.brain.rawValue
            )
        } else {
            ScrollView {
                LazyVStack(spacing: VSpacing.xs) {
                    ForEach(displayedPages) { page in
                        row(for: page)
                    }
                }
            }
            .scrollContentBackground(.hidden)
        }
    }

    @ViewBuilder
    private func row(for page: MemoryV2ConceptPageSummary) -> some View {
        let isSelected = selectedSlug == page.slug
        Button {
            withAnimation(VAnimation.panel) { selectedSlug = page.slug }
        } label: {
            HStack(alignment: .center, spacing: VSpacing.sm) {
                Text(page.slug)
                    .font(.system(.body, design: .monospaced))
                    .foregroundStyle(VColor.contentDefault)
                    .lineLimit(1)
                    .truncationMode(.tail)

                Spacer(minLength: VSpacing.sm)

                Text("\(page.bodyBytes) bytes · \(page.edgeCount) edges")
                    .font(VFont.labelDefault)
                    .foregroundStyle(VColor.contentTertiary)
            }
            .padding(EdgeInsets(top: VSpacing.xs, leading: VSpacing.md, bottom: VSpacing.xs, trailing: VSpacing.md))
            .background(
                RoundedRectangle(cornerRadius: VRadius.sm)
                    .fill(isSelected ? VColor.surfaceActive : Color.clear)
            )
            .contentShape(RoundedRectangle(cornerRadius: VRadius.sm))
        }
        .buttonStyle(.plain)
        .accessibilityAddTraits(isSelected ? .isSelected : [])
    }

    // MARK: - Data

    private func loadPages() async {
        isLoading = true
        defer { isLoading = false }
        switch await client.listConceptPages() {
        case .success(let response):
            v2Disabled = false
            pages = response.pages
        case .disabled:
            v2Disabled = true
            pages = []
        case .error:
            v2Disabled = false
        }
    }
}
