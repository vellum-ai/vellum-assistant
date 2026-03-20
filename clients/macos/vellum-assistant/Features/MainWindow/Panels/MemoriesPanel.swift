import SwiftUI
import VellumAssistantShared

// MARK: - Section Tab

private enum MemorySection: String, CaseIterable {
    case observations = "Observations"
    case episodes = "Episodes"
    case brief = "Brief"
}

// MARK: - Memories Panel

struct MemoriesPanel: View {
    @Binding var focusedMemoryId: String?
    @StateObject private var store: SimplifiedMemoryStore
    @State private var selectedSection: MemorySection = .observations
    @State private var showCreateSheet = false
    @State private var searchDebounceTask: Task<Void, Never>?

    init(focusedMemoryId: Binding<String?> = .constant(nil)) {
        _focusedMemoryId = focusedMemoryId
        _store = StateObject(wrappedValue: SimplifiedMemoryStore(client: SimplifiedMemoryClient()))
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            toolBar
            sectionTabs
                .padding(.top, VSpacing.md)
            sectionContent
                .padding(.top, VSpacing.lg)
        }
        .task { await store.loadMemories() }
        .task(id: focusedMemoryId) {
            guard focusedMemoryId != nil else { return }
            withAnimation(VAnimation.fast) { selectedSection = .observations }
            focusedMemoryId = nil
        }
        .onDisappear {
            searchDebounceTask?.cancel()
            searchDebounceTask = nil
        }
        .sheet(isPresented: $showCreateSheet) {
            MemoryCreateSheet(
                store: store,
                onDismiss: { showCreateSheet = false }
            )
        }
    }

    // MARK: - Tool Bar

    @ViewBuilder
    private var toolBar: some View {
        HStack(spacing: VSpacing.sm) {
            VSearchBar(placeholder: "Search Memories", text: $store.searchText)
                .onChange(of: store.searchText) {
                    searchDebounceTask?.cancel()
                    searchDebounceTask = Task {
                        try? await Task.sleep(nanoseconds: 300_000_000)
                        guard !Task.isCancelled else { return }
                        await store.loadMemories()
                    }
                }

            VButton(label: "New", icon: VIcon.plus.rawValue, style: .primary) {
                showCreateSheet = true
            }
            .accessibilityLabel("Add new memory")
        }
        .padding(.top, VSpacing.sm)
    }

    // MARK: - Section Tabs

    @ViewBuilder
    private var sectionTabs: some View {
        HStack(spacing: VSpacing.sm) {
            ForEach(MemorySection.allCases, id: \.self) { section in
                sectionPill(section)
            }
            Spacer()
        }
    }

    @ViewBuilder
    private func sectionPill(_ section: MemorySection) -> some View {
        let isActive = selectedSection == section
        Button {
            withAnimation(VAnimation.fast) { selectedSection = section }
        } label: {
            Text(section.rawValue)
                .font(VFont.captionMedium)
                .foregroundColor(isActive ? VColor.contentEmphasized : VColor.contentSecondary)
                .padding(.horizontal, VSpacing.md)
                .padding(.vertical, VSpacing.xs)
                .background(isActive ? VColor.surfaceActive : Color.clear)
                .clipShape(Capsule())
                .overlay(
                    Capsule().stroke(isActive ? VColor.borderBase : VColor.borderDisabled, lineWidth: 1)
                )
                .contentShape(Capsule())
        }
        .buttonStyle(.plain)
        .accessibilityAddTraits(isActive ? .isSelected : [])
    }

    // MARK: - Section Content

    @ViewBuilder
    private var sectionContent: some View {
        if store.isLoading && store.observations.isEmpty && store.episodes.isEmpty {
            VStack {
                Spacer()
                VLoadingIndicator()
                Spacer()
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        } else {
            switch selectedSection {
            case .observations:
                observationsSection
            case .episodes:
                episodesSection
            case .brief:
                briefSection
            }
        }
    }
}

// MARK: - Observations Section

extension MemoriesPanel {

    @ViewBuilder
    private var observationsSection: some View {
        if store.observations.isEmpty {
            VEmptyState(
                title: "No Memories Yet",
                subtitle: "Your assistant builds memories from your conversations. Have a chat and check back.",
                icon: VIcon.lightbulb.rawValue
            )
        } else {
            ScrollView {
                LazyVStack(spacing: VSpacing.md) {
                    ForEach(store.observations) { observation in
                        MemoryObservationRow(
                            observation: observation,
                            onDelete: {
                                Task { _ = await store.deleteObservation(id: observation.id) }
                            }
                        )
                    }
                }
                .background { OverlayScrollerStyle() }
            }
            .scrollContentBackground(.hidden)
        }
    }
}

// MARK: - Episodes Section

extension MemoriesPanel {

    @ViewBuilder
    private var episodesSection: some View {
        if store.episodes.isEmpty {
            VEmptyState(
                title: "No Episodes Yet",
                subtitle: "Episodes are narrative summaries your assistant creates from longer interactions.",
                icon: VIcon.bookOpen.rawValue
            )
        } else {
            ScrollView {
                LazyVStack(spacing: VSpacing.md) {
                    ForEach(store.episodes) { episode in
                        MemoryEpisodeRow(episode: episode)
                    }
                }
                .background { OverlayScrollerStyle() }
            }
            .scrollContentBackground(.hidden)
        }
    }
}

// MARK: - Brief Section

extension MemoriesPanel {

    @ViewBuilder
    private var briefSection: some View {
        let hasTimeContexts = !store.timeContexts.isEmpty
        let hasOpenLoops = !store.openLoops.isEmpty

        if !hasTimeContexts && !hasOpenLoops {
            VEmptyState(
                title: "No Brief Items Yet",
                subtitle: "Time contexts and open loops from your conversations will appear here.",
                icon: VIcon.clock.rawValue
            )
        } else {
            ScrollView {
                LazyVStack(alignment: .leading, spacing: VSpacing.xl) {
                    if hasTimeContexts {
                        timeContextsSubsection
                    }
                    if hasOpenLoops {
                        openLoopsSubsection
                    }
                }
                .background { OverlayScrollerStyle() }
            }
            .scrollContentBackground(.hidden)
        }
    }

    @ViewBuilder
    private var timeContextsSubsection: some View {
        VStack(alignment: .leading, spacing: VSpacing.md) {
            Text("Time Contexts")
                .font(VFont.bodyBold)
                .foregroundColor(VColor.contentDefault)

            ForEach(store.timeContexts) { ctx in
                timeContextCard(ctx)
            }
        }
    }

    @ViewBuilder
    private func timeContextCard(_ ctx: MemoryTimeContextPayload) -> some View {
        VStack(alignment: .leading, spacing: VSpacing.sm) {
            Text(ctx.summary)
                .font(VFont.body)
                .foregroundColor(VColor.contentDefault)
                .lineLimit(3)
                .frame(maxWidth: .infinity, alignment: .topLeading)

            HStack(spacing: VSpacing.sm) {
                VIconView(.calendar, size: 11)
                    .foregroundColor(VColor.contentTertiary)
                    .accessibilityHidden(true)
                Text("Active: \(formattedDateRange(from: ctx.activeFromDate, to: ctx.activeUntilDate))")
                    .font(VFont.caption)
                    .foregroundColor(VColor.contentTertiary)
                Spacer()
            }
        }
        .padding(VSpacing.lg)
        .overlay(
            RoundedRectangle(cornerRadius: VRadius.xl)
                .stroke(VColor.borderDisabled, lineWidth: 1)
        )
        .clipShape(RoundedRectangle(cornerRadius: VRadius.xl))
    }

    @ViewBuilder
    private var openLoopsSubsection: some View {
        VStack(alignment: .leading, spacing: VSpacing.md) {
            Text("Open Loops")
                .font(VFont.bodyBold)
                .foregroundColor(VColor.contentDefault)

            ForEach(store.openLoops) { loop in
                openLoopCard(loop)
            }
        }
    }

    @ViewBuilder
    private func openLoopCard(_ loop: MemoryOpenLoopPayload) -> some View {
        VStack(alignment: .leading, spacing: VSpacing.sm) {
            Text(loop.summary)
                .font(VFont.body)
                .foregroundColor(VColor.contentDefault)
                .lineLimit(3)
                .frame(maxWidth: .infinity, alignment: .topLeading)

            HStack(spacing: VSpacing.sm) {
                statusBadge(loop.status)

                if let dueDate = loop.dueDate {
                    HStack(spacing: VSpacing.xxs) {
                        VIconView(.clock, size: 11)
                            .foregroundColor(VColor.contentTertiary)
                            .accessibilityHidden(true)
                        Text("Due: \(formattedShortDate(dueDate))")
                            .font(VFont.caption)
                            .foregroundColor(VColor.contentTertiary)
                    }
                }

                Spacer()
            }
        }
        .padding(VSpacing.lg)
        .overlay(
            RoundedRectangle(cornerRadius: VRadius.xl)
                .stroke(VColor.borderDisabled, lineWidth: 1)
        )
        .clipShape(RoundedRectangle(cornerRadius: VRadius.xl))
    }

    // MARK: - Helpers

    private func statusBadge(_ status: String) -> some View {
        let tone: VBadge.Tone = switch status {
        case "open": .warning
        case "resolved": .positive
        case "expired": .neutral
        default: .neutral
        }
        return VBadge(label: status.capitalized, tone: tone, emphasis: .subtle, shape: .pill)
    }

    private func formattedDateRange(from start: Date, to end: Date) -> String {
        let formatter = DateFormatter()
        formatter.dateFormat = "MMM d"
        return "\(formatter.string(from: start)) \u{2013} \(formatter.string(from: end))"
    }

    private func formattedShortDate(_ date: Date) -> String {
        let formatter = DateFormatter()
        formatter.dateFormat = "MMM d"
        return formatter.string(from: date)
    }
}
