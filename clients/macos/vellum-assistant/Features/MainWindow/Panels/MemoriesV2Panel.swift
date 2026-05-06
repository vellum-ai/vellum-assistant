import SwiftUI
import VellumAssistantShared

// MARK: - Memories V2 Panel

/// Browse-able list of memory v2 concept pages. Renders a sorted list of
/// concept-page summaries (slug, body size, edge count) loaded via
/// `MemoryV2Client`. Replaces `MemoriesPanel` when `memory-v2-enabled` is on
/// — wired in by the IntelligencePanel flag-gate (PR 6 of the plan).
struct MemoriesV2Panel: View {
    let connectionManager: GatewayConnectionManager

    @State private var pages: [MemoryV2ConceptPageSummary] = []
    @State private var isLoading: Bool = true
    @State private var loadError: String?

    private let client: MemoryV2ClientProtocol

    init(connectionManager: GatewayConnectionManager, client: MemoryV2ClientProtocol = MemoryV2Client()) {
        self.connectionManager = connectionManager
        self.client = client
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            listContent
        }
        .padding(.top, VSpacing.lg)
        .task { await loadPages() }
    }

    // MARK: - List Content

    @ViewBuilder
    private var listContent: some View {
        if isLoading {
            VStack {
                Spacer()
                VLoadingIndicator()
                Spacer()
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        } else if let loadError {
            VEmptyState(
                title: "Couldn't load concept pages",
                subtitle: loadError,
                icon: VIcon.brain.rawValue
            )
        } else if pages.isEmpty {
            VEmptyState(
                title: "No concept pages yet",
                subtitle: "Memory v2 builds concept pages as the assistant reflects on your conversations. Check back after some chats.",
                icon: VIcon.brain.rawValue
            )
        } else {
            ScrollView {
                LazyVStack(spacing: VSpacing.xs) {
                    ForEach(pages) { page in
                        row(for: page)
                    }
                }
            }
            .scrollContentBackground(.hidden)
        }
    }

    @ViewBuilder
    private func row(for page: MemoryV2ConceptPageSummary) -> some View {
        HStack(alignment: .center, spacing: VSpacing.sm) {
            Text(page.slug)
                .font(.system(.body, design: .monospaced))
                .foregroundStyle(VColor.contentDefault)
                .lineLimit(1)
                .truncationMode(.tail)

            Spacer(minLength: VSpacing.sm)

            Text("\(page.bodyChars) chars · \(page.edgeCount) edges")
                .font(VFont.labelDefault)
                .foregroundStyle(VColor.contentTertiary)
        }
        .padding(.horizontal, VSpacing.md)
        .padding(.vertical, VSpacing.xs)
    }

    // MARK: - Data

    private func loadPages() async {
        isLoading = true
        defer { isLoading = false }
        if let response = await client.listConceptPages() {
            pages = response.pages.sorted { $0.slug < $1.slug }
            loadError = nil
        } else {
            loadError = "Failed to load concept pages."
        }
    }
}
