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
/// glance dashboard before the list-to-detail nav lands in PR 22.
struct ACPSessionsPanel: View {
    @Bindable var store: ACPSessionStore
    var onClose: (() -> Void)?

    var body: some View {
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
        .onAppear {
            if store.seedState == .idle {
                Task { await store.seed() }
            }
        }
    }

    // MARK: - Header bar (count + refresh)

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
        }
        .padding(.horizontal, VSpacing.lg)
        .padding(.vertical, VSpacing.sm)

        Divider().background(VColor.borderBase)
    }

    private var countLabel: String {
        let count = store.sessionOrder.count
        return count == 1 ? "1 agent" : "\(count) agents"
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
            ForEach(store.sessionOrder, id: \.self) { sessionId in
                if let viewModel = store.sessions[sessionId] {
                    ACPSessionsPanelRow(state: viewModel.state)
                    if sessionId != store.sessionOrder.last {
                        Divider().background(VColor.borderBase)
                    }
                }
            }
        }
    }
}

// MARK: - Row

/// Single row in the Coding Agents list. Renders an agent badge, a status
/// pill, the elapsed time since `startedAt`, and a truncated parent
/// conversation id. Disclosure indicator is purely visual until PR 22 wires
/// the list-to-detail navigation.
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
