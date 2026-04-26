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
///   detail column is a placeholder until PR 33 ships the iOS detail view.
/// - **Compact (iPhone)** — wraps in a `NavigationStack` so taps push onto
///   the existing stack. The detail destination is a placeholder until PR
///   33 lands.
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

    var body: some View {
        Group {
            if horizontalSizeClass == .regular {
                NavigationSplitView {
                    listContent
                } detail: {
                    detailContent
                }
            } else {
                NavigationStack {
                    listContent
                        .navigationDestination(for: String.self) { sessionId in
                            ACPSessionDetailPlaceholder(sessionId: sessionId)
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
            // double-bind the selection.
            ACPSessionsViewRow(state: state)
                .tag(state.acpSessionId)
        } else {
            // Compact: NavigationStack push via `value:` keeps the row
            // tap target large and matches the iOS list idiom.
            NavigationLink(value: state.acpSessionId) {
                ACPSessionsViewRow(state: state)
            }
        }
    }

    // MARK: - Detail content (regular size class)

    @ViewBuilder
    private var detailContent: some View {
        if let id = selectedSessionId {
            ACPSessionDetailPlaceholder(sessionId: id)
        } else {
            Text("Select a coding agent")
                .font(VFont.bodyMediumLighter)
                .foregroundStyle(VColor.contentSecondary)
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

// MARK: - Detail placeholder

/// Stand-in for the iOS detail view that PR 33 will introduce. Surfaces the
/// session id so the placeholder is at least useful during testing of the
/// list view in isolation.
private struct ACPSessionDetailPlaceholder: View {
    let sessionId: String

    var body: some View {
        VStack(spacing: VSpacing.md) {
            Text("Coding agent detail")
                .font(VFont.titleSmall)
                .foregroundStyle(VColor.contentDefault)
            Text(sessionId)
                .font(VFont.labelSmall.monospaced())
                .foregroundStyle(VColor.contentTertiary)
                .textSelection(.enabled)
            Text("Detail view ships in a follow-up PR.")
                .font(VFont.bodyMediumLighter)
                .foregroundStyle(VColor.contentSecondary)
                .multilineTextAlignment(.center)
        }
        .padding(VSpacing.xl)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}
#endif
