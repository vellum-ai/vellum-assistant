#if canImport(UIKit)
import SwiftUI
import VellumAssistantShared

private enum MemoryTab: String, CaseIterable {
    case observations = "Observations"
    case episodes = "Episodes"
    case brief = "Brief"
}

struct MemoriesListView: View {
    @ObservedObject var store: SimplifiedMemoryStore
    @State private var selectedTab: MemoryTab = .observations
    @State private var searchText = ""
    @State private var showCreateSheet = false
    @State private var searchDebounceTask: Task<Void, Never>?

    var body: some View {
        VStack(spacing: 0) {
            segmentedPicker
            tabContent
        }
        .searchable(text: $searchText, prompt: "Search memories...")
        .onChange(of: searchText) { _, newValue in
            store.searchText = newValue
            searchDebounceTask?.cancel()
            searchDebounceTask = Task {
                try? await Task.sleep(nanoseconds: 300_000_000)
                guard !Task.isCancelled else { return }
                await store.loadMemories()
            }
        }
        .onDisappear { searchDebounceTask?.cancel() }
        .navigationTitle("Memories")
        .toolbar {
            ToolbarItem(placement: .primaryAction) {
                Button {
                    showCreateSheet = true
                } label: {
                    VIconView(.plus, size: 16)
                }
            }
        }
        .refreshable { await store.loadMemories() }
        .task { await store.loadMemories() }
        .sheet(isPresented: $showCreateSheet) {
            NavigationStack {
                MemoryCreateView(store: store)
            }
        }
    }

    // MARK: - Segmented Picker

    private var segmentedPicker: some View {
        Picker("Section", selection: $selectedTab) {
            ForEach(MemoryTab.allCases, id: \.self) { tab in
                Text(tab.rawValue).tag(tab)
            }
        }
        .pickerStyle(.segmented)
        .padding(.horizontal)
        .padding(.vertical, VSpacing.sm)
    }

    // MARK: - Tab Content

    @ViewBuilder
    private var tabContent: some View {
        switch selectedTab {
        case .observations:
            observationsTab
        case .episodes:
            episodesTab
        case .brief:
            briefTab
        }
    }

    // MARK: - Observations Tab

    @ViewBuilder
    private var observationsTab: some View {
        if store.isLoading && store.observations.isEmpty {
            loadingState
        } else if store.observations.isEmpty {
            emptyState(icon: .bookOpen, title: "No Observations", message: "Your assistant learns from conversations.")
        } else {
            observationsList
        }
    }

    private var observationsList: some View {
        List {
            ForEach(store.observations) { observation in
                NavigationLink {
                    MemoryObservationDetailView(observation: observation, store: store)
                } label: {
                    observationRow(observation)
                }
                .swipeActions(edge: .trailing) {
                    Button("Delete", role: .destructive) {
                        Task { _ = await store.deleteObservation(id: observation.id) }
                    }
                }
            }
        }
    }

    private func observationRow(_ observation: MemoryObservationPayload) -> some View {
        HStack(spacing: VSpacing.sm) {
            roleIndicator(observation.role)

            VStack(alignment: .leading, spacing: 2) {
                Text(observation.content)
                    .font(VFont.body)
                    .foregroundColor(VColor.contentDefault)
                    .lineLimit(2)
            }

            Spacer()

            Text(observation.relativeCreatedAt)
                .font(VFont.caption)
                .foregroundColor(VColor.contentTertiary)
        }
        .padding(.vertical, 2)
        .accessibilityElement(children: .combine)
        .accessibilityLabel("Observation: \(observation.content). \(observation.relativeCreatedAt)")
    }

    // MARK: - Episodes Tab

    @ViewBuilder
    private var episodesTab: some View {
        if store.isLoading && store.episodes.isEmpty {
            loadingState
        } else if store.episodes.isEmpty {
            emptyState(icon: .bookOpen, title: "No Episodes", message: "Episodes are generated from conversation history.")
        } else {
            episodesList
        }
    }

    private var episodesList: some View {
        List {
            ForEach(store.episodes) { episode in
                episodeRow(episode)
            }
        }
    }

    private func episodeRow(_ episode: MemoryEpisodePayload) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(episode.title)
                .font(VFont.bodyMedium)
                .foregroundColor(VColor.contentDefault)
                .lineLimit(1)

            Text(episode.summary)
                .font(VFont.body)
                .foregroundColor(VColor.contentSecondary)
                .lineLimit(2)

            Text(formatTimeSpan(start: episode.startDate, end: episode.endDate))
                .font(VFont.caption)
                .foregroundColor(VColor.contentTertiary)
        }
        .padding(.vertical, 2)
        .accessibilityElement(children: .combine)
        .accessibilityLabel("Episode: \(episode.title). \(episode.summary)")
    }

    // MARK: - Brief Tab

    @ViewBuilder
    private var briefTab: some View {
        if store.isLoading && store.timeContexts.isEmpty && store.openLoops.isEmpty {
            loadingState
        } else if store.timeContexts.isEmpty && store.openLoops.isEmpty {
            emptyState(icon: .bookOpen, title: "No Brief", message: "Time contexts and open loops will appear here.")
        } else {
            briefList
        }
    }

    private var briefList: some View {
        List {
            if !store.timeContexts.isEmpty {
                Section("Time Contexts") {
                    ForEach(store.timeContexts) { context in
                        timeContextRow(context)
                    }
                }
            }
            if !store.openLoops.isEmpty {
                Section("Open Loops") {
                    ForEach(store.openLoops) { loop in
                        openLoopRow(loop)
                    }
                }
            }
        }
    }

    private func timeContextRow(_ context: MemoryTimeContextPayload) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(context.summary)
                .font(VFont.body)
                .foregroundColor(VColor.contentDefault)
                .lineLimit(2)

            HStack(spacing: VSpacing.xs) {
                VIconView(.clock, size: 12)
                    .foregroundColor(VColor.contentTertiary)
                Text("\(formatDate(context.activeFromDate)) - \(formatDate(context.activeUntilDate))")
                    .font(VFont.caption)
                    .foregroundColor(VColor.contentTertiary)
            }
        }
        .padding(.vertical, 2)
        .accessibilityElement(children: .combine)
        .accessibilityLabel("Time context: \(context.summary)")
    }

    private func openLoopRow(_ loop: MemoryOpenLoopPayload) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(loop.summary)
                .font(VFont.body)
                .foregroundColor(VColor.contentDefault)
                .lineLimit(2)

            HStack(spacing: VSpacing.xs) {
                statusBadge(loop.status)
                if let dueDate = loop.dueDate {
                    Text("Due: \(formatDate(dueDate))")
                        .font(VFont.caption)
                        .foregroundColor(VColor.contentTertiary)
                }
            }
        }
        .padding(.vertical, 2)
        .accessibilityElement(children: .combine)
        .accessibilityLabel("Open loop: \(loop.summary), status: \(loop.status)")
    }

    // MARK: - Role Indicator

    private func roleIndicator(_ role: String) -> some View {
        let color: Color = {
            switch role {
            case "user": return .blue
            case "assistant": return .purple
            case "system": return .orange
            default: return VColor.contentTertiary
            }
        }()

        return Circle()
            .fill(color)
            .frame(width: 8, height: 8)
            .accessibilityLabel("Role: \(role)")
    }

    // MARK: - Status Badge

    private func statusBadge(_ status: String) -> some View {
        let color: Color = {
            switch status {
            case "open": return .orange
            case "resolved": return .green
            case "stale": return .secondary
            default: return .secondary
            }
        }()

        return Text(status.capitalized)
            .font(.caption2)
            .padding(.horizontal, 5)
            .padding(.vertical, 1)
            .background(Capsule().fill(color.opacity(0.15)))
            .foregroundColor(color)
    }

    // MARK: - Empty / Loading States

    private func emptyState(icon: VIcon, title: String, message: String) -> some View {
        VStack(spacing: VSpacing.lg) {
            VIconView(icon, size: 48)
                .foregroundColor(VColor.contentTertiary)
                .accessibilityHidden(true)

            Text(title)
                .font(VFont.title)
                .foregroundColor(VColor.contentDefault)

            Text(message)
                .font(VFont.body)
                .foregroundColor(VColor.contentSecondary)
                .multilineTextAlignment(.center)
                .padding(.horizontal, VSpacing.xl)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .accessibilityElement(children: .combine)
        .accessibilityLabel("\(title). \(message)")
    }

    private var loadingState: some View {
        VStack(spacing: VSpacing.md) {
            ProgressView()
            Text("Loading memories...")
                .font(VFont.body)
                .foregroundColor(VColor.contentSecondary)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    // MARK: - Formatting Helpers

    private func formatTimeSpan(start: Date, end: Date) -> String {
        let formatter = DateFormatter()
        formatter.dateStyle = .medium
        formatter.timeStyle = .none
        return "\(formatter.string(from: start)) - \(formatter.string(from: end))"
    }

    private func formatDate(_ date: Date) -> String {
        let formatter = DateFormatter()
        formatter.dateStyle = .medium
        formatter.timeStyle = .short
        return formatter.string(from: date)
    }
}
#endif
