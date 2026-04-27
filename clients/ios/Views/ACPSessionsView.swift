#if canImport(UIKit)
import SwiftUI
import VellumAssistantShared

/// iOS surface for the Coding Agents (ACP sessions) list.
///
/// Mirrors ``ACPSessionsPanel`` on macOS — same header, same empty state,
/// same row content — but renders inside a `List` so iOS swipe actions and
/// pull-to-refresh light up natively.
///
/// Size-class adaptation:
/// - **Regular (iPad)** — wraps the list in a `NavigationSplitView`. The
///   detail column hosts ``ACPSessionDetailViewIOS`` once a row is selected.
/// - **Compact (iPhone)** — wraps in a `NavigationStack` so taps push the
///   detail view onto the existing stack with a native back-swipe affordance.
///
/// Sources of truth: ``ACPSessionStore`` for `sessions` / `sessionOrder`,
/// SSE-driven via the daemon's `acp_session_*` events. Initial population
/// happens on first appear via ``ACPSessionStore/seed()``.
struct ACPSessionsView: View {
    @Environment(\.horizontalSizeClass) private var horizontalSizeClass
    @Bindable var store: ACPSessionStore

    /// Optional close hook so callers presenting this view in a modal context
    /// (the Coding Agents sheet driven from ``IOSRootNavigationView``'s
    /// terminal-icon toolbar entry) can dismiss it via the in-view close
    /// button.
    var onClose: (() -> Void)?

    @State private var selectedSessionId: String?

    /// Mutable navigation path so the inline `acp_spawn` chat tap can
    /// push a detail view programmatically on compact iPhone. Mirrors
    /// the `navigationPath` on macOS's `ACPSessionsPanel` and lets
    /// ``consumeSelectedSessionIdIfPresent`` flush a pending deep link
    /// without rebuilding the navigation hierarchy from scratch.
    @State private var navigationPath: [String] = []

    var body: some View {
        Group {
            if horizontalSizeClass == .regular {
                NavigationSplitView {
                    listContent
                } detail: {
                    detailContent
                }
            } else {
                NavigationStack(path: $navigationPath) {
                    listContent
                        .navigationDestination(for: String.self) { sessionId in
                            detailView(for: sessionId)
                        }
                }
            }
        }
        .task {
            // `.task` fires once on first appear and is cancelled on
            // disappear, so we don't need an explicit `onAppear` guard.
            // Only seed once — re-entry while loaded should not trigger
            // an extra round-trip.
            if store.seedState == .idle {
                await store.seed()
            }
            // If a deep-link landed before this sheet mounted (e.g.
            // tapping an inline `acp_spawn` chat block opens the sheet
            // and sets the id in the same tick), consume it now so the
            // user lands directly on the detail view instead of the
            // list.
            consumeSelectedSessionIdIfPresent()
        }
        .onChange(of: store.selectedSessionId) { _, _ in
            consumeSelectedSessionIdIfPresent()
        }
    }

    /// Consume a pending `store.selectedSessionId`, routing it to the
    /// size-class-appropriate selection mechanism. Defers to the pure
    /// helper ``consumeSelectedSessionIdIfPresent(store:isCompact:selected:path:)``
    /// so unit tests can exercise the consumption logic without standing
    /// up a SwiftUI view tree.
    func consumeSelectedSessionIdIfPresent() {
        Self.consumeSelectedSessionIdIfPresent(
            store: store,
            isCompact: horizontalSizeClass != .regular,
            selected: &selectedSessionId,
            path: &navigationPath
        )
    }

    /// Pure helper that drives the deep-link consumption against an
    /// arbitrary store + path / selection pair. `static` so tests can
    /// call it directly with their own storage. Idempotent: if the
    /// requested session is already at the top of the stack (compact)
    /// or already selected (regular), the field is still cleared but
    /// the push is skipped to avoid stacking duplicate detail views.
    static func consumeSelectedSessionIdIfPresent(
        store: ACPSessionStore,
        isCompact: Bool,
        selected: inout String?,
        path: inout [String]
    ) {
        guard let id = store.selectedSessionId,
              store.sessions[id] != nil else {
            // Either no deep link, or the row hasn't streamed in yet.
            // Leaving the field set lets a later spawn + re-trigger
            // flush the deep link when the SSE event finally arrives.
            return
        }
        // Clear first so reentrant `onChange` invocations don't loop.
        store.selectedSessionId = nil
        if isCompact {
            if path.last == id { return }
            path.append(id)
        } else {
            if selected == id { return }
            selected = id
        }
    }

    // MARK: - List content

    @ViewBuilder
    private var listContent: some View {
        Group {
            if store.sessionOrder.isEmpty {
                VEmptyState(
                    title: "No coding agents yet",
                    subtitle: "Ask the assistant to spawn Claude or Codex.",
                    icon: "terminal"
                )
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else {
                sessionList
            }
        }
        .navigationTitle("Coding Agents")
        .toolbar {
            // The header bar in ``ACPSessionsPanel`` shows the count as
            // an inline label and refresh as a ghost button. On iOS the
            // navigation bar is the natural home for both — count goes in
            // the principal slot, refresh in trailing.
            ToolbarItem(placement: .principal) {
                Text(countLabel)
                    .font(VFont.labelSmall)
                    .foregroundStyle(VColor.contentTertiary)
            }
            ToolbarItem(placement: .navigationBarTrailing) {
                Button {
                    Task { await store.seed() }
                } label: {
                    VIconView(.refreshCw, size: 18)
                }
                .disabled(store.seedState == .loading)
                .accessibilityLabel("Refresh coding agents")
            }
            if let onClose {
                ToolbarItem(placement: .navigationBarLeading) {
                    Button(action: onClose) {
                        VIconView(.x, size: 18)
                    }
                    .accessibilityLabel("Close")
                }
            }
        }
    }

    private var sessionList: some View {
        // `sessionOrder` is keyed by `state.id` (the daemon UUID), so the
        // swipe-to-cancel and selection bindings below all flow through
        // the canonical identifier the daemon's mutation routes accept.
        List(selection: horizontalSizeClass == .regular ? $selectedSessionId : nil) {
            ForEach(store.sessionOrder, id: \.self) { sessionId in
                if let viewModel = store.sessions[sessionId] {
                    sessionRow(for: viewModel.state)
                        .swipeActions(edge: .trailing, allowsFullSwipe: false) {
                            if Self.isCancellable(viewModel.state.status) {
                                Button(role: .destructive) {
                                    Task { await store.cancel(id: sessionId) }
                                } label: {
                                    Label { Text("Cancel") } icon: { VIconView(.x, size: 14) }
                                }
                            }
                        }
                }
            }
        }
        .listStyle(.plain)
        .refreshable {
            await store.seed()
        }
    }

    @ViewBuilder
    private func sessionRow(for state: ACPSessionState) -> some View {
        if horizontalSizeClass == .regular {
            // Regular: rely on `List(selection:)` to drive the detail
            // pane. Wrapping the row in a `NavigationLink` would
            // double-bind the selection. Tag value is the daemon UUID so
            // the selection binding flows through the same key the store
            // uses.
            ACPSessionsViewRow(state: state)
                .tag(state.id)
        } else {
            // Compact: NavigationStack push via `value:` keeps the row
            // tap target large and matches the iOS list idiom. Pushed
            // value is the daemon UUID — `detailView(for:)` uses it to
            // look the session up in the store.
            NavigationLink(value: state.id) {
                ACPSessionsViewRow(state: state)
            }
        }
    }

    // MARK: - Detail content (regular size class)

    @ViewBuilder
    private var detailContent: some View {
        if let id = selectedSessionId {
            detailView(for: id)
        } else {
            Text("Select a coding agent")
                .font(VFont.bodyMediumLighter)
                .foregroundStyle(VColor.contentSecondary)
                .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
    }

    /// Resolves a row's `acpSessionId` to its live ``ACPSessionViewModel``
    /// and hands it to ``ACPSessionDetailViewIOS``. Resolving on every render
    /// is fine because the store keeps view-model identity stable for the
    /// lifetime of a session — SwiftUI's diffing reuses the open detail
    /// view as `state` / `events` mutate via SSE.
    ///
    /// If the id is unknown (e.g. a deep link races with an SSE that hasn't
    /// arrived yet) we fall back to a graceful empty state so the navigation
    /// destination still renders something rather than crashing on a
    /// force-unwrap.
    @ViewBuilder
    private func detailView(for sessionId: String) -> some View {
        if let viewModel = store.sessions[sessionId] {
            ACPSessionDetailViewIOS(
                session: viewModel,
                store: store,
                onDismiss: horizontalSizeClass == .regular
                    ? { selectedSessionId = nil }
                    : nil
            )
        } else {
            VEmptyState(
                title: "Session unavailable",
                subtitle: "Try refreshing the list.",
                icon: "terminal"
            )
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
    }

    // MARK: - Helpers

    private var countLabel: String {
        let count = store.sessionOrder.count
        return count == 1 ? "1 agent" : "\(count) agents"
    }

    /// Only running / initializing sessions can be cancelled — terminal
    /// states already have a final stop reason. Exposed `static` so the
    /// test target can pin the contract without instantiating the view.
    static func isCancellable(_ status: ACPSessionState.Status) -> Bool {
        switch status {
        case .running, .initializing: return true
        case .completed, .failed, .cancelled, .unknown: return false
        }
    }
}

// MARK: - Row

/// Single row in the iOS Coding Agents list. Visual content matches
/// ``ACPSessionsPanelRow`` on macOS: an agent badge, a status pill, the
/// elapsed time since `startedAt`, and a truncated parent conversation id.
/// The disclosure chevron is omitted because `NavigationLink` and
/// `List(selection:)` already render their own platform-appropriate
/// affordance.
struct ACPSessionsViewRow: View {
    let state: ACPSessionState

    var body: some View {
        HStack(alignment: .center, spacing: VSpacing.md) {
            agentBadge
            VStack(alignment: .leading, spacing: VSpacing.xxs) {
                statusPill
                metadataLine
            }
            Spacer(minLength: VSpacing.md)
        }
        .padding(.vertical, VSpacing.xs)
        .frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityElement(children: .combine)
        .accessibilityLabel(accessibilityLabel)
    }

    @ViewBuilder
    private var agentBadge: some View {
        Text(ACPSessionStateFormatter.agentLabel(for: state.agentId))
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
        let tint = ACPSessionStateFormatter.statusColor(state.status)
        return HStack(spacing: VSpacing.xs) {
            Circle()
                .fill(tint)
                .frame(width: 6, height: 6)
            Text(ACPSessionStateFormatter.statusLabel(state.status))
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
            Text(ACPSessionStateFormatter.elapsedLabel(startedAt: state.startedAt, completedAt: state.completedAt))
                .font(VFont.labelSmall)
                .foregroundStyle(VColor.contentTertiary)
                .monospacedDigit()
            if let parentLabel = ACPSessionStateFormatter.parentConversationLabel(state.parentConversationId) {
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
            ACPSessionStateFormatter.agentLabel(for: state.agentId),
            ACPSessionStateFormatter.statusLabel(state.status),
            ACPSessionStateFormatter.elapsedLabel(startedAt: state.startedAt, completedAt: state.completedAt)
        ]
        if let parentLabel = ACPSessionStateFormatter.parentConversationLabel(state.parentConversationId) {
            parts.append("conversation \(parentLabel)")
        }
        return parts.joined(separator: ", ")
    }
}

#endif
