import SwiftUI
import VellumAssistantShared

/// Skeleton list view for the Coding Agents (ACP sessions) panel.
///
/// Drives off the shared ``ACPSessionStore`` so SSE-driven inserts/updates
/// stream into the list without explicit refresh logic. Routing into the
/// panel is wired up in a follow-up PR (see ``PanelCoordinator``); this PR
/// only stands up the visual shell.
///
/// The empty state mirrors ``SubagentDetailPanel`` — same `VEmptyState`
/// shape, same panel chrome — so the two coding-agent surfaces feel like a
/// single family. Each row is intentionally information-dense (badge +
/// status pill + elapsed + parent conversation) so the panel can act as a
/// glance dashboard.
///
/// List → detail navigation uses `NavigationStack`: tapping a row pushes
/// ``ACPSessionDetailView`` with the live ``ACPSessionViewModel`` (not a
/// snapshot) so streaming updates flow into the open detail view without
/// the parent having to reach back into the store on every tick.
struct ACPSessionsPanel: View {
    @Bindable var store: ACPSessionStore
    /// Currently active conversation id used to drive the
    /// "This conversation" / "All" filter. When `nil` the segmented control
    /// is hidden and every session is shown — there is no conversation to
    /// scope against.
    var activeConversationId: String?
    var onClose: (() -> Void)?

    /// Drives the destructive-confirmation alert for the overflow menu's
    /// "Clear completed history" action. Hoisted to view state so the menu
    /// itself can dismiss while the alert remains presented.
    @State private var showClearCompletedConfirm: Bool = false

    /// Per-conversation filter preference, persisted in `UserDefaults`
    /// under `acp.filter.<conversationId>`.
    @State private var filterStorage = ACPSessionsPanelFilterStorage()

    /// Mutable navigation path so external triggers (e.g. tapping an
    /// inline `acp_spawn` tool block in a chat bubble) can push a detail
    /// view programmatically. The value type stored on the path is
    /// ``ACPSessionViewModel`` to match the existing
    /// `navigationDestination(for: ACPSessionViewModel.self)` block —
    /// reusing the live view model means streaming SSE updates flow into
    /// the detail view without a pop-and-push cycle.
    @State private var navigationPath: [ACPSessionViewModel] = []

    var body: some View {
        NavigationStack(path: $navigationPath) {
            VSidePanel(
                title: "Coding Agents",
                titleFont: VFont.titleSmall,
                onClose: onClose,
                pinnedContent: { headerBar }
            ) {
                if store.sessionOrder.isEmpty {
                    VEmptyState(
                        title: "No coding agents yet",
                        subtitle: "Ask the assistant to spawn Claude or Codex.",
                        icon: "terminal"
                    )
                } else {
                    sessionList
                }
            }
            .navigationDestination(for: ACPSessionViewModel.self) { viewModel in
                // Pass the live view model — `ACPSessionViewModel` is
                // `@Observable`, so SwiftUI re-renders the detail view as
                // its `state` / `events` mutate via SSE without forcing a
                // pop-and-push cycle.
                ACPSessionDetailView(session: viewModel, store: store)
            }
        }
        .onAppear {
            if store.seedState == .idle {
                Task { await store.seed() }
            }
            // If a deep-link landed before the panel mounted (e.g. tapping
            // an inline tool block opens the panel and sets the id in the
            // same tick), consume it now so the user lands directly on the
            // detail view instead of the list.
            consumeSelectedSessionIdIfPresent()
        }
        .onChange(of: store.selectedSessionId) {
            consumeSelectedSessionIdIfPresent()
        }
        .alert("Clear completed history?", isPresented: $showClearCompletedConfirm) {
            Button("Cancel", role: .cancel) {}
            Button("Clear", role: .destructive) {
                Task { await store.clearCompleted() }
            }
        } message: {
            Text("This removes every completed, failed, and cancelled coding agent from the list. Active agents stay.")
        }
    }

    /// Consume a pending `store.selectedSessionId`, pushing the matching
    /// view model onto the navigation path. Defers to the pure helper
    /// ``consumeSelectedSessionIdIfPresent(store:path:)`` so unit tests
    /// can exercise the consumption logic without standing up a SwiftUI
    /// view tree (which strips `@State` mutations on detached struct
    /// values).
    ///
    /// Idempotent on the path: if the requested session is already at the
    /// top of the stack, we still clear the store field but skip the push
    /// to avoid stacking duplicate detail views. Resilient to a deep-link
    /// arriving before its matching SSE `acp_session_spawned` event — the
    /// field stays set so a subsequent consume (driven by the next
    /// `onChange` tick or panel mount) can flush once the row appears.
    func consumeSelectedSessionIdIfPresent() {
        Self.consumeSelectedSessionIdIfPresent(store: store, path: &navigationPath)
    }

    /// Pure helper that drives the deep-link consumption against an
    /// arbitrary store + path pair. `static` so tests can call it
    /// directly with their own `[ACPSessionViewModel]` storage.
    static func consumeSelectedSessionIdIfPresent(
        store: ACPSessionStore,
        path: inout [ACPSessionViewModel]
    ) {
        guard let id = store.selectedSessionId,
              let viewModel = store.sessions[id] else {
            return
        }
        // Clear first so reentrant `onChange` invocations don't loop.
        store.selectedSessionId = nil
        if path.last === viewModel { return }
        path.append(viewModel)
    }

    // MARK: - Header bar (count + refresh + overflow menu)

    @ViewBuilder
    private var headerBar: some View {
        HStack(alignment: .center) {
            Text(countLabel)
                .font(VFont.labelSmall)
                .foregroundStyle(VColor.contentTertiary)
            Spacer()
            VButton(
                label: "Refresh",
                iconOnly: VIcon.refreshCw.rawValue,
                style: .ghost,
                isDisabled: store.seedState == .loading,
                action: { Task { await store.seed() } }
            )
            .accessibilityLabel("Refresh coding agents")
            overflowMenu
        }
        .padding(.horizontal, VSpacing.lg)
        .padding(.vertical, VSpacing.sm)

        if activeConversationId != nil {
            filterPicker
        }

        Divider().background(VColor.borderBase)
    }

    /// Header overflow ("…") menu. Currently only houses the destructive
    /// "Clear completed history" action; future bulk actions (e.g.
    /// "Cancel all running") slot into the same menu.
    @ViewBuilder
    private var overflowMenu: some View {
        Menu {
            Button("Clear completed history", role: .destructive) {
                showClearCompletedConfirm = true
            }
            .disabled(!hasTerminalSessions)
        } label: {
            VIconView(.ellipsis, size: 14)
                .foregroundStyle(VColor.contentTertiary)
                .frame(width: 24, height: 24)
        }
        .menuStyle(.borderlessButton)
        .menuIndicator(.hidden)
        .fixedSize()
        .accessibilityLabel("More coding agent actions")
    }

    /// Whether any session in the store is in a terminal state. Drives the
    /// disabled state of "Clear completed history" so the action only lights
    /// up when there is actually something to clear.
    private var hasTerminalSessions: Bool {
        store.sessions.values.contains { ACPSessionStore.isTerminal($0.state.status) }
    }

    @ViewBuilder
    private var filterPicker: some View {
        Picker("Filter coding agents", selection: filterBinding) {
            Text("This conversation").tag(ACPSessionsPanelFilter.thisConversation)
            Text("All").tag(ACPSessionsPanelFilter.all)
        }
        .labelsHidden()
        .pickerStyle(.segmented)
        .padding(.horizontal, VSpacing.lg)
        .padding(.bottom, VSpacing.sm)
        .accessibilityLabel("Filter coding agents")
    }

    private var filterBinding: Binding<ACPSessionsPanelFilter> {
        Binding(
            get: { activeFilter },
            set: { newValue in filterStorage.setFilter(newValue, for: activeConversationId) }
        )
    }

    /// Currently effective filter for the panel. Reads the stored
    /// preference if one exists; otherwise falls back to a context-aware
    /// default — `.thisConversation` when at least one session matches the
    /// active conversation, `.all` otherwise. The default is computed at
    /// read-time rather than seeded into storage so the picker updates
    /// naturally when sessions stream in after the panel mounts.
    private var activeFilter: ACPSessionsPanelFilter {
        guard let activeConversationId else { return .all }
        if filterStorage.hasStoredFilter(for: activeConversationId) {
            return filterStorage.filter(for: activeConversationId)
        }
        return store.sessions(forConversation: activeConversationId).isEmpty
            ? .all : .thisConversation
    }

    private var countLabel: String {
        let count = filteredSessions.count
        return count == 1 ? "1 agent" : "\(count) agents"
    }

    /// Sessions that should appear in the list once the active filter is
    /// applied. Defined here so the count label and the list iterate the
    /// same set without recomputing.
    private var filteredSessions: [ACPSessionViewModel] {
        guard let activeConversationId, activeFilter == .thisConversation else {
            return store.sessionOrder.compactMap { store.sessions[$0] }
        }
        return store.sessions(forConversation: activeConversationId)
    }

    // MARK: - Session list

    @ViewBuilder
    private var sessionList: some View {
        // Eager `VStack` is intentional: per `clients/AGENTS.md`, lazy
        // containers are required for unbounded data — but ``ACPSessionStore``
        // bounds `sessionOrder` to live ACP sessions, which is small in
        // practice and capped indirectly by the daemon. An eager stack keeps
        // initial paint simpler and avoids the lazy-container row recycling
        // overhead for short lists.
        VStack(alignment: .leading, spacing: 0) {
            let visible = filteredSessions
            ForEach(visible, id: \.id) { viewModel in
                // `NavigationLink(value:)` defers detail construction to
                // the parent's `navigationDestination`, so passing the live
                // `ACPSessionViewModel` does not capture a stale snapshot
                // — the destination reads observable properties off the
                // same instance the store mutates.
                NavigationLink(value: viewModel) {
                    ACPSessionsPanelRow(state: viewModel.state)
                }
                .buttonStyle(.plain)
                if viewModel.id != visible.last?.id {
                    Divider().background(VColor.borderBase)
                }
            }
        }
    }
}

// MARK: - Filter

/// Two-state filter for ``ACPSessionsPanel``. Persisted to `UserDefaults`
/// via its raw value — never rename or remove cases without a migration.
enum ACPSessionsPanelFilter: String {
    case thisConversation
    case all
}

/// Conversation-keyed filter preference. Reads/writes are keyed by the
/// active conversation id so each conversation remembers its own
/// preference independently.
///
/// Persistence lives in `UserDefaults`; the `@Observable` cache is what
/// drives SwiftUI invalidation when the binding flips, since `UserDefaults`
/// writes alone do not trigger view updates.
@Observable
final class ACPSessionsPanelFilterStorage {
    /// Observed cache. Mutating an entry invalidates any view that reads
    /// the same key via ``filter(for:)``. Persisted writes flow through
    /// `UserDefaults` so the preference survives relaunches.
    private var cache: [String: ACPSessionsPanelFilter] = [:]

    /// Defaults instance used for persistence. Held as a property so tests
    /// can substitute an isolated suite without touching
    /// `UserDefaults.standard`.
    @ObservationIgnored private let defaults: UserDefaults

    init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
    }

    func filter(for conversationId: String?) -> ACPSessionsPanelFilter {
        guard let conversationId else { return .all }
        if let cached = cache[conversationId] { return cached }
        if let raw = defaults.string(forKey: Self.key(for: conversationId)),
           let value = ACPSessionsPanelFilter(rawValue: raw) {
            return value
        }
        return .thisConversation
    }

    func setFilter(_ filter: ACPSessionsPanelFilter, for conversationId: String?) {
        guard let conversationId else { return }
        // Update the observed cache first so SwiftUI invalidates views that
        // read this key, then persist for relaunch.
        cache[conversationId] = filter
        defaults.set(filter.rawValue, forKey: Self.key(for: conversationId))
    }

    func hasStoredFilter(for conversationId: String) -> Bool {
        if cache[conversationId] != nil { return true }
        return defaults.object(forKey: Self.key(for: conversationId)) != nil
    }

    static func key(for conversationId: String) -> String {
        "acp.filter.\(conversationId)"
    }
}

// MARK: - Row

/// Single row in the Coding Agents list. Renders an agent badge, a status
/// pill, the elapsed time since `startedAt`, and a truncated parent
/// conversation id. The trailing chevron previews the list-to-detail push
/// driven by the parent's `NavigationStack`.
struct ACPSessionsPanelRow: View {
    let state: ACPSessionState

    var body: some View {
        HStack(alignment: .center, spacing: VSpacing.md) {
            agentBadge
            VStack(alignment: .leading, spacing: VSpacing.xxs) {
                statusPill
                metadataLine
            }
            Spacer(minLength: VSpacing.md)
            VIconView(.chevronRight, size: 10)
                .foregroundStyle(VColor.contentTertiary)
                .accessibilityHidden(true)
        }
        .padding(.horizontal, VSpacing.lg)
        .padding(.vertical, VSpacing.md)
        .frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityElement(children: .combine)
        .accessibilityLabel(accessibilityLabel)
    }

    // MARK: - Subviews

    @ViewBuilder
    private var agentBadge: some View {
        Text(Self.agentLabel(for: state.agentId))
            .font(VFont.labelDefault)
            .foregroundStyle(VColor.contentDefault)
            .padding(.horizontal, VSpacing.sm)
            .padding(.vertical, VSpacing.xxs)
            .background(
                Capsule()
                    .fill(VColor.surfaceOverlay)
            )
    }

    private var statusPill: some View {
        let tint = Self.statusColor(state.status)
        return HStack(spacing: VSpacing.xs) {
            Circle()
                .fill(tint)
                .frame(width: 6, height: 6)
            Text(Self.statusLabel(state.status))
                .font(VFont.labelDefault)
                .foregroundStyle(tint)
        }
        .padding(.horizontal, VSpacing.sm)
        .padding(.vertical, VSpacing.xxs)
        .background(
            Capsule()
                .fill(tint.opacity(0.12))
        )
    }

    @ViewBuilder
    private var metadataLine: some View {
        HStack(spacing: VSpacing.xs) {
            Text(Self.elapsedLabel(startedAt: state.startedAt, completedAt: state.completedAt))
                .font(VFont.labelSmall)
                .foregroundStyle(VColor.contentTertiary)
                .monospacedDigit()
            if let parentLabel = Self.parentConversationLabel(state.parentConversationId) {
                Text("·")
                    .font(VFont.labelSmall)
                    .foregroundStyle(VColor.contentTertiary)
                    .accessibilityHidden(true)
                Text(parentLabel)
                    .font(VFont.labelSmall)
                    .foregroundStyle(VColor.contentTertiary)
                    .lineLimit(1)
                    .truncationMode(.middle)
            }
        }
    }

    private var accessibilityLabel: String {
        var parts: [String] = [
            Self.agentLabel(for: state.agentId),
            Self.statusLabel(state.status),
            Self.elapsedLabel(startedAt: state.startedAt, completedAt: state.completedAt)
        ]
        if let parentLabel = Self.parentConversationLabel(state.parentConversationId) {
            parts.append("conversation \(parentLabel)")
        }
        return parts.joined(separator: ", ")
    }

    // MARK: - Formatting (static for testability)

    /// Unknown ids fall through to the raw value so a new agent type still
    /// renders without a code change.
    static func agentLabel(for agentId: String) -> String {
        switch agentId {
        case "claude-code": return "Claude"
        case "codex": return "Codex"
        default: return agentId
        }
    }

    static func statusLabel(_ status: ACPSessionState.Status) -> String {
        switch status {
        case .initializing: return "Starting"
        case .running: return "Running"
        case .completed: return "Completed"
        case .failed: return "Failed"
        case .cancelled: return "Cancelled"
        case .unknown: return "Unknown"
        }
    }

    static func statusColor(_ status: ACPSessionState.Status) -> Color {
        switch status {
        case .running, .initializing: return VColor.primaryActive
        case .completed: return VColor.systemPositiveStrong
        case .failed, .cancelled: return VColor.systemNegativeStrong
        case .unknown: return VColor.contentTertiary
        }
    }

    /// Locale-aware "5m ago" for live sessions; wall-clock duration for
    /// terminated sessions so a finished row doesn't keep ticking.
    static func elapsedLabel(startedAt: Int, completedAt: Int?) -> String {
        let started = Date(timeIntervalSince1970: TimeInterval(startedAt) / 1000)
        if let completedAt {
            let completed = Date(timeIntervalSince1970: TimeInterval(completedAt) / 1000)
            return VCollapsibleStepRowDurationFormatter.format(
                max(0, completed.timeIntervalSince(started))
            )
        }
        let formatter = RelativeDateTimeFormatter()
        formatter.unitsStyle = .abbreviated
        return formatter.localizedString(for: started, relativeTo: Date())
    }

    /// Returns `nil` for empty/missing ids so the metadata line degrades
    /// gracefully instead of rendering a stray separator.
    static func parentConversationLabel(_ parentId: String?) -> String? {
        guard let parentId, !parentId.isEmpty else { return nil }
        let prefixLength = 8
        if parentId.count <= prefixLength { return parentId }
        return String(parentId.prefix(prefixLength)) + "…"
    }
}
