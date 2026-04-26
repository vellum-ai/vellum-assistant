#if canImport(UIKit)
import SwiftUI
import VellumAssistantShared

// MARK: - ACPSessionDetailView (iOS)

/// iOS detail view of an ACP (Agent Client Protocol) session.
///
/// Mirrors ``ACPSessionDetailView`` on macOS — same header (agent + status +
/// elapsed + parent-conversation link), same scrolling timeline of
/// ``ACPSessionUpdateMessage`` events grouped into visual rows, same
/// context-sensitive footer (steering textbox+button while running, "Delete
/// from history" once terminal). Tool-call updates coalesce with their
/// ``ACPSessionUpdateMessage/UpdateType/toolCallUpdate`` siblings (latest
/// update wins) so a streaming tool that emits multiple status transitions
/// still renders as a single row.
///
/// The pure event-stream → timeline-row reduction lives on the macOS view as
/// `ACPSessionDetailView.buildRows(events:)`. We deliberately keep the
/// rendering details here in iOS-land — Markdown rendering uses SwiftUI's
/// `Text(LocalizedStringKey(...))` since the macOS `MarkdownSegmentView`
/// imports AppKit — and call into the shared store for all mutations so iOS
/// and macOS see identical wire-level behavior.
///
/// Touch-tuning:
/// - Action buttons (cancel, steer, delete) hit 44pt tap targets per HIG.
/// - The steer textbox is keyboard-aware; SwiftUI's automatic
///   `.keyboardLayoutGuide` push lifts the footer above the system keyboard
///   on iPhone.
/// - The timeline supports interactive keyboard dismiss via
///   `.scrollDismissesKeyboard(.interactively)` so a drag past the keyboard
///   collapses it without losing draft text.
///
/// Auto-scroll mirrors macOS behavior: pinned to the bottom while the user is
/// parked there, paused once they scroll up to read past content, resumed
/// when they return to the bottom anchor.
struct ACPSessionDetailViewIOS: View {
    let session: ACPSessionViewModel
    /// Store used to drive optimistic mutations from this view (cancel,
    /// steer, delete). Held by reference so the view always invokes the
    /// caller-owned instance — there's only one ``ACPSessionStore`` per app.
    let store: ACPSessionStore
    /// Tap on the parent-conversation link. `nil` hides the link.
    var onSelectParentConversation: ((String) -> Void)? = nil
    /// Pop-to-list callback fired after a successful "Delete from history".
    /// The parent (a `NavigationStack` or `NavigationSplitView`) is
    /// responsible for the actual back-pop; we just signal that the
    /// underlying row is gone. On compact iPhone we read `dismiss` from the
    /// environment and pop ourselves; this hook gives regular-width hosts a
    /// way to clear their selection too.
    var onDismiss: (() -> Void)? = nil

    @Environment(\.dismiss) private var dismiss

    /// True while a cancel HTTP request is in flight. Disables the button and
    /// shows an inline spinner so the user can't double-tap.
    @State private var cancelInFlight = false

    /// Sentinel ID anchored at the bottom of the LazyVStack so the
    /// `ScrollViewReader` can scroll to "the latest" without depending on
    /// per-event identity (which churns as the events array mutates).
    private static let bottomAnchorId = "ACPSessionDetailIOS.bottomAnchor"

    /// True while auto-scroll is active. Flipped to false the moment the
    /// user scrolls upward, and back to true once they return to the bottom.
    @State private var autoScrollEnabled = true
    /// Last observed scroll offset reported by the timeline.
    @State private var lastScrollOffset: CGFloat = 0
    /// Last observed bottom offset (content height − viewport height).
    @State private var lastMaxScrollOffset: CGFloat = 0
    /// Wall clock used to refresh the elapsed time once per second while the
    /// session is still running. Read only when non-terminal so terminal
    /// sessions don't wake the timer.
    @State private var nowTick: Date = Date()
    /// Bound text content of the steer textbox. Cleared on every successful
    /// submission so the field is ready for the next instruction.
    @State private var steerInput: String = ""
    /// True while a "Delete from history" request is in flight.
    @State private var isDeleting = false

    /// Persisted preference for whether agent-thought bubbles render in the
    /// timeline. Defaults to `true` so first-time users see the assistant's
    /// reasoning surface without hunting for a toggle. Persists across
    /// detail-view re-opens via `@AppStorage` (uses the same key as macOS so
    /// the preference roams between platforms via iCloud key-value sync if
    /// the app opts in later).
    @AppStorage("acp.showThoughts") private var showThoughts: Bool = true

    private static let elapsedTickInterval: TimeInterval = 1
    private static let scrollAtBottomTolerance: CGFloat = 4
    /// Minimum touch target per Apple HIG — applied to action buttons in
    /// the header and footer so they're reliably tappable.
    private static let minTouchTarget: CGFloat = 44

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            header
            Divider().background(VColor.borderBase)
            timeline
            if session.state.status == .running {
                Divider().background(VColor.borderBase)
                steerFooter
            }
            if isDeletable {
                Divider().background(VColor.borderBase)
                deleteFooter
            }
        }
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .principal) {
                Text(ACPSessionStateFormatter.agentLabel(for: session.state.agentId))
                    .font(VFont.titleSmall)
                    .foregroundStyle(VColor.contentDefault)
                    .lineLimit(1)
            }
        }
    }

    // MARK: - Header

    @ViewBuilder
    private var header: some View {
        VStack(alignment: .leading, spacing: VSpacing.sm) {
            HStack(alignment: .center, spacing: VSpacing.sm) {
                statusPill
                Spacer()
                if isCancelable {
                    cancelControl
                }
            }

            HStack(alignment: .center, spacing: VSpacing.md) {
                elapsedView
                if let parent = session.state.parentConversationId,
                   let onSelectParentConversation {
                    parentConversationLink(id: parent, onTap: onSelectParentConversation)
                }
                Spacer()
                showThoughtsToggle
            }
        }
        .padding(EdgeInsets(top: VSpacing.lg, leading: VSpacing.lg, bottom: VSpacing.md, trailing: VSpacing.lg))
    }

    /// Header-strip toggle that hides agent-thought bubbles from the
    /// timeline.
    @ViewBuilder
    private var showThoughtsToggle: some View {
        HStack(spacing: VSpacing.xs) {
            VIconView(.lightbulb, size: 12)
                .foregroundStyle(VColor.contentSecondary)
                .accessibilityHidden(true)
            VToggle(isOn: $showThoughts, label: "Show thoughts")
        }
    }

    /// Cancel is only meaningful while the session is still running — terminal
    /// statuses already reached an end state and re-cancelling is a no-op at
    /// the daemon. We treat `.initializing` as cancelable too so the user can
    /// abort a stuck-starting session.
    ///
    /// `internal` rather than `private` so unit tests can verify the gating
    /// without rendering the view.
    var isCancelable: Bool {
        switch session.state.status {
        case .running, .initializing: return true
        case .completed, .failed, .cancelled, .unknown: return false
        }
    }

    @ViewBuilder
    private var cancelControl: some View {
        HStack(spacing: VSpacing.xs) {
            if cancelInFlight {
                ProgressView()
                    .controlSize(.small)
                    .accessibilityLabel("Cancelling session")
            }
            VButton(
                label: "Cancel",
                style: .dangerGhost,
                size: .compact,
                isDisabled: cancelInFlight
            ) {
                handleCancelTap()
            }
            .frame(minHeight: Self.minTouchTarget)
            .accessibilityLabel("Cancel session")
        }
    }

    /// `internal` rather than `private` so unit tests can drive the cancel
    /// flow without reaching into SwiftUI's view tree.
    func handleCancelTap() {
        guard !cancelInFlight else { return }
        cancelInFlight = true
        // `state.id` (the daemon UUID) is the canonical identifier the
        // daemon's `acp/:id/cancel` route looks up — `state.acpSessionId`
        // is the protocol-level handle and would 404 the route for any
        // session past initialization.
        let id = session.state.id
        Task { @MainActor in
            // The store flips `state.status` optimistically on success, which
            // hides this control via `isCancelable`. On failure we reset the
            // in-flight flag so the user can retry.
            _ = await store.cancel(id: id)
            cancelInFlight = false
        }
    }

    @ViewBuilder
    private var statusPill: some View {
        VBadge(
            label: statusLabel(session.state.status),
            tone: statusTone(session.state.status),
            emphasis: .subtle
        )
        .accessibilityLabel("Status: \(statusLabel(session.state.status))")
    }

    private func statusLabel(_ status: ACPSessionState.Status) -> String {
        switch status {
        case .initializing: return "Starting"
        case .running:      return "Running"
        case .completed:    return "Completed"
        case .failed:       return "Failed"
        case .cancelled:    return "Cancelled"
        case .unknown:      return "Unknown"
        }
    }

    private func statusTone(_ status: ACPSessionState.Status) -> VBadge.Tone {
        switch status {
        case .running, .initializing: return .accent
        case .completed:              return .positive
        case .failed:                 return .danger
        case .cancelled, .unknown:    return .neutral
        }
    }

    @ViewBuilder
    private var elapsedView: some View {
        let formatted = Self.formatElapsed(elapsedSeconds())
        Text(formatted)
            .font(VFont.numericMono)
            .foregroundStyle(VColor.contentSecondary)
            .accessibilityLabel("Elapsed: \(formatted)")
            .onReceive(Timer.publish(every: Self.elapsedTickInterval, on: .main, in: .common).autoconnect()) { tick in
                // Skip ticks once the session reaches a terminal state — its
                // `completedAt` is frozen and re-rendering would just thrash.
                guard session.state.completedAt == nil else { return }
                nowTick = tick
            }
    }

    /// Returns the elapsed runtime in seconds. Reading `nowTick` here is
    /// intentional — it forces SwiftUI to track the timer and re-evaluate
    /// once per second while the session is running.
    private func elapsedSeconds() -> TimeInterval {
        let startedSeconds = TimeInterval(session.state.startedAt) / 1000
        let endSeconds: TimeInterval
        if let completedAt = session.state.completedAt {
            endSeconds = TimeInterval(completedAt) / 1000
        } else {
            endSeconds = nowTick.timeIntervalSince1970
        }
        return max(0, endSeconds - startedSeconds)
    }

    static func formatElapsed(_ seconds: TimeInterval) -> String {
        let total = Int(seconds.rounded(.down))
        let h = total / 3600
        let m = (total % 3600) / 60
        let s = total % 60
        if h > 0 {
            return String(format: "%d:%02d:%02d", h, m, s)
        }
        return String(format: "%d:%02d", m, s)
    }

    @ViewBuilder
    private func parentConversationLink(id: String, onTap: @escaping (String) -> Void) -> some View {
        Button {
            onTap(id)
        } label: {
            HStack(spacing: VSpacing.xxs) {
                VIconView(.link, size: 11)
                Text("Parent conversation")
                    .font(VFont.labelDefault)
            }
            .foregroundStyle(VColor.primaryBase)
            // `contentShape` widens the Button's hit-test region from the
            // tightly-fit label to the full HStack so a stray miss on the
            // gap between icon and text still registers as a tap.
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel("Open parent conversation")
    }

    // MARK: - Timeline

    @ViewBuilder
    private var timeline: some View {
        let allRows = TimelineRowBuilder.buildRows(events: session.events)
        let rows = showThoughts ? allRows : allRows.filter { row in
            if case .thought = row { return false }
            return true
        }
        if rows.isEmpty {
            VEmptyState(
                title: "No events yet",
                subtitle: "Events will appear as the session runs",
                icon: "waveform.path"
            )
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        } else {
            ScrollViewReader { proxy in
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: VSpacing.md) {
                        ForEach(rows) { row in
                            renderRow(row)
                        }
                        // Sentinel — `.id` for ScrollViewReader anchoring.
                        Color.clear
                            .frame(height: 1)
                            .id(Self.bottomAnchorId)
                    }
                    .padding(EdgeInsets(top: VSpacing.lg, leading: VSpacing.lg, bottom: VSpacing.lg, trailing: VSpacing.lg))
                    .background(scrollOffsetReader)
                }
                .coordinateSpace(name: "acp-timeline-ios")
                // Lets the user dismiss the keyboard by dragging the
                // timeline — important on iPhone where the steer textbox
                // would otherwise stay docked above the keyboard while the
                // timeline is the primary reading surface.
                .scrollDismissesKeyboard(.interactively)
                .onPreferenceChange(ACPSessionDetailIOSScrollOffsetKey.self) { contentMinY in
                    handleScrollOffsetChange(contentMinY)
                }
                .onChange(of: session.events.count) {
                    if autoScrollEnabled {
                        // .easeOut keeps the jump readable when many events
                        // arrive at once.
                        withAnimation(.easeOut(duration: 0.1)) {
                            proxy.scrollTo(Self.bottomAnchorId, anchor: .bottom)
                        }
                    }
                }
                .onAppear {
                    // First-paint: park at the bottom so the user lands on
                    // the latest activity instead of the start of the log.
                    proxy.scrollTo(Self.bottomAnchorId, anchor: .bottom)
                }
            }
        }
    }

    /// Background view that publishes the timeline's scroll offset through a
    /// SwiftUI `PreferenceKey` so the parent can observe scroll direction
    /// without dropping into UIKit gesture recognizers.
    @ViewBuilder
    private var scrollOffsetReader: some View {
        GeometryReader { geo in
            Color.clear.preference(
                key: ACPSessionDetailIOSScrollOffsetKey.self,
                value: geo.frame(in: .named("acp-timeline-ios")).minY
            )
        }
    }

    private func handleScrollOffsetChange(_ contentMinY: CGFloat) {
        // Same direction-tracking heuristic as macOS — see comment in
        // `ACPSessionDetailView.swift` for the rationale.
        let currentOffset = -contentMinY
        defer { lastScrollOffset = currentOffset }

        if currentOffset > lastMaxScrollOffset {
            lastMaxScrollOffset = currentOffset
        }

        let movedUp = currentOffset < lastScrollOffset - Self.scrollAtBottomTolerance
        let returnedToBottom = abs(currentOffset - lastMaxScrollOffset) < Self.scrollAtBottomTolerance

        if movedUp {
            autoScrollEnabled = false
        } else if returnedToBottom {
            autoScrollEnabled = true
        }
    }

    // MARK: - Row Rendering

    @ViewBuilder
    private func renderRow(_ row: TimelineRow) -> some View {
        switch row {
        case .agentMessage(_, let content):
            messageBubble(content: content, isUser: false)
        case .userMessage(_, let content):
            messageBubble(content: content, isUser: true)
        case .toolCall(_, let toolCallId, let title, let kind, let status):
            toolCallRow(toolCallId: toolCallId, title: title, kind: kind, status: status)
        case .plan(_, let items):
            planChecklist(items: items)
        case .thought(_, let content):
            thoughtRow(content: content)
        }
    }

    @ViewBuilder
    private func messageBubble(content: String, isUser: Bool) -> some View {
        HStack(spacing: 0) {
            VStack(alignment: .leading, spacing: VSpacing.xxs) {
                Text(isUser ? "USER" : "AGENT")
                    .font(VFont.labelSmall)
                    .foregroundStyle(VColor.contentTertiary)
                // SwiftUI's `Text` accepts a `LocalizedStringKey` that
                // renders inline markdown (bold, italic, links, code spans).
                // That covers what agent / user message chunks emit; we
                // intentionally keep this lightweight on iOS rather than
                // porting macOS's `MarkdownSegmentView` (which imports
                // AppKit and is therefore unavailable to the iOS target).
                Text(LocalizedStringKey(content))
                    .font(VFont.bodyMediumDefault)
                    .foregroundStyle(VColor.contentDefault)
                    .textSelection(.enabled)
                    .fixedSize(horizontal: false, vertical: true)
            }
            .padding(VSpacing.sm)
            .background(
                RoundedRectangle(cornerRadius: VRadius.md)
                    .fill(isUser ? VColor.primaryBase.opacity(0.08) : VColor.surfaceOverlay.opacity(0.6))
            )
            Spacer(minLength: 0)
        }
    }

    @ViewBuilder
    private func toolCallRow(toolCallId: String, title: String, kind: String?, status: String?) -> some View {
        HStack(alignment: .center, spacing: VSpacing.sm) {
            VIconView(toolKindIcon(kind), size: 14)
                .foregroundStyle(VColor.contentSecondary)
            VStack(alignment: .leading, spacing: 0) {
                Text(title)
                    .font(VFont.bodyMediumDefault)
                    .foregroundStyle(VColor.contentDefault)
                    .lineLimit(1)
                if let kind, !kind.isEmpty {
                    Text(kind)
                        .font(VFont.labelSmall)
                        .foregroundStyle(VColor.contentTertiary)
                }
            }
            Spacer(minLength: 0)
            toolStatusPill(status: status)
        }
        .padding(EdgeInsets(top: VSpacing.xs, leading: VSpacing.sm, bottom: VSpacing.xs, trailing: VSpacing.sm))
        .background(
            RoundedRectangle(cornerRadius: VRadius.md)
                .fill(VColor.surfaceOverlay.opacity(0.6))
        )
        .accessibilityElement(children: .combine)
        .accessibilityLabel("Tool call: \(title), status \(toolStatusLabel(status))")
    }

    @ViewBuilder
    private func toolStatusPill(status: String?) -> some View {
        VBadge(
            label: toolStatusLabel(status),
            tone: toolStatusTone(status),
            emphasis: .subtle
        )
    }

    private func toolStatusLabel(_ status: String?) -> String {
        guard let status, !status.isEmpty else { return "Pending" }
        return status.replacingOccurrences(of: "_", with: " ").capitalized
    }

    private func toolStatusTone(_ status: String?) -> VBadge.Tone {
        switch (status ?? "").lowercased() {
        case "completed", "succeeded", "success": return .positive
        case "failed", "error":                    return .danger
        case "running", "in_progress":             return .accent
        default:                                    return .neutral
        }
    }

    private func toolKindIcon(_ kind: String?) -> VIcon {
        switch (kind ?? "").lowercased() {
        case "read", "fetch":          return .fileText
        case "edit", "write":          return .squarePen
        case "search", "grep":         return .search
        case "execute", "bash", "shell", "run": return .terminal
        case "browse", "web":          return .globe
        case "think":                  return .sparkles
        default:                        return .wrench
        }
    }

    @ViewBuilder
    private func planChecklist(items: [TimelineRowBuilder.PlanItem]) -> some View {
        HStack(spacing: 0) {
            VStack(alignment: .leading, spacing: VSpacing.xs) {
                Text("PLAN")
                    .font(VFont.labelSmall)
                    .foregroundStyle(VColor.contentTertiary)
                ForEach(Array(items.enumerated()), id: \.offset) { _, item in
                    HStack(alignment: .top, spacing: VSpacing.xs) {
                        VIconView(item.isComplete ? .circleCheck : .circle, size: 12)
                            .foregroundStyle(item.isComplete ? VColor.systemPositiveStrong : VColor.contentTertiary)
                        Text(item.text)
                            .font(VFont.bodyMediumDefault)
                            .foregroundStyle(item.isComplete ? VColor.contentTertiary : VColor.contentDefault)
                            .strikethrough(item.isComplete, color: VColor.contentTertiary)
                            .textSelection(.enabled)
                    }
                }
            }
            .padding(VSpacing.sm)
            .background(
                RoundedRectangle(cornerRadius: VRadius.md)
                    .fill(VColor.surfaceOverlay.opacity(0.4))
            )
            Spacer(minLength: 0)
        }
    }

    @ViewBuilder
    private func thoughtRow(content: String) -> some View {
        HStack(spacing: 0) {
            HStack(alignment: .top, spacing: VSpacing.xs) {
                VIconView(.lightbulb, size: 12)
                    .foregroundStyle(Color.secondary)
                    .padding(.top, 2)
                Text(content)
                    .font(VFont.bodyMediumDefault.italic())
                    .foregroundStyle(Color.secondary)
                    .textSelection(.enabled)
            }
            .padding(VSpacing.sm)
            .background(
                RoundedRectangle(cornerRadius: VRadius.md)
                    .fill(VColor.surfaceOverlay.opacity(0.4))
            )
            .accessibilityElement(children: .combine)
            .accessibilityLabel("Agent thought: \(content)")
            Spacer(minLength: 0)
        }
    }

    // MARK: - Steer Footer

    @ViewBuilder
    private var steerFooter: some View {
        HStack(alignment: .center, spacing: VSpacing.sm) {
            // VTextField manages its own focus internally — `submitLabel`
            // here propagates through to the underlying SwiftUI TextField
            // so the keyboard's return key reads "Send" instead of the
            // platform default of "Return".
            VTextField(
                placeholder: "Redirect this agent…",
                text: $steerInput,
                onSubmit: dispatchSteer
            )
            .submitLabel(.send)
            VButton(
                label: "Steer",
                style: .primary,
                isDisabled: steerInput.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
                action: dispatchSteer
            )
            .frame(minHeight: Self.minTouchTarget)
        }
        .padding(EdgeInsets(top: VSpacing.md, leading: VSpacing.lg, bottom: VSpacing.md, trailing: VSpacing.lg))
    }

    /// View-side wrapper that snapshots and clears `steerInput` *before*
    /// handing the raw text off to ``submitSteer(rawInstruction:)``.
    /// Keeping the `@State` mutation here means the helper itself is purely
    /// a function of its arguments, which is what the unit test exploits.
    private func dispatchSteer() {
        let toSubmit = steerInput
        steerInput = ""
        submitSteer(rawInstruction: toSubmit)
    }

    /// Trim ``rawInstruction``, append a synthetic `→ steered: …` row to the
    /// timeline so the user sees the instruction land immediately, then
    /// dispatch the steer call against the store. Empty/whitespace input is
    /// a no-op so a stray return-key press is harmless.
    ///
    /// `internal` rather than `private` so unit tests can drive submission
    /// without round-tripping through SwiftUI focus state.
    func submitSteer(rawInstruction: String) {
        let instruction = rawInstruction.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !instruction.isEmpty else { return }

        // Synthetic local-only event — surfaces the steer in the timeline
        // before the daemon's confirmation round-trips back as an SSE update.
        // We piggy-back on `userMessageChunk` rather than introducing a new
        // wire-side update type so `buildRows` keeps a closed switch and the
        // entry coalesces naturally with any prior user-message run.
        session.appendEvent(ACPSessionUpdateMessage(
            acpSessionId: session.state.acpSessionId,
            updateType: .userMessageChunk,
            content: "→ steered: \(instruction)"
        ))

        // `state.id` is the daemon UUID — the value the steer route
        // (`acp/:id/steer`) accepts and the store keys its dictionary by.
        // `state.acpSessionId` is the protocol-level handle and would
        // miss the lookup for any session past initialization.
        Task { await store.steer(id: session.state.id, instruction: instruction) }
    }

    // MARK: - Delete Footer

    /// Delete-from-history is only meaningful once the session has reached a
    /// terminal status. The daemon also enforces this with a 409 on active
    /// sessions, so gating the button is purely about avoiding a confusing
    /// affordance that would always fail.
    var isDeletable: Bool {
        ACPSessionStore.isTerminal(session.state.status)
    }

    @ViewBuilder
    private var deleteFooter: some View {
        HStack(alignment: .center, spacing: VSpacing.sm) {
            Spacer()
            VButton(
                label: "Delete from history",
                leftIcon: "trash",
                style: .dangerGhost,
                size: .compact,
                isDisabled: isDeleting
            ) {
                handleDeleteTap()
            }
            .frame(minHeight: Self.minTouchTarget)
            .accessibilityLabel("Delete session from history")
        }
        .padding(EdgeInsets(top: VSpacing.md, leading: VSpacing.lg, bottom: VSpacing.md, trailing: VSpacing.lg))
    }

    /// `internal` rather than `private` so unit tests can drive the delete
    /// flow without reaching into SwiftUI's view tree.
    func handleDeleteTap() {
        guard !isDeleting else { return }
        isDeleting = true
        // `state.id` is the daemon UUID — what
        // `acp_session_history.id` is keyed by and what the
        // `DELETE /v1/acp/sessions/:id` route looks up.
        let id = session.state.id
        Task { @MainActor in
            let result = await store.delete(id: id)
            isDeleting = false
            // Pop only on a successful row removal so the user has a chance
            // to react if the daemon reports a 409 (still active) or other
            // failure — the row stays put and the button re-enables.
            if case .success = result {
                if let onDismiss {
                    onDismiss()
                } else {
                    // Compact iPhone hosts the detail in a NavigationStack;
                    // pop ourselves so the user lands back on the list
                    // without the parent having to wire a callback.
                    dismiss()
                }
            }
        }
    }
}

// MARK: - Timeline Row Model

/// Pure event-stream → row reduction shared between platforms in spirit.
/// The macOS detail view has its own copy nested inside ``ACPSessionDetailView``;
/// we mirror the structure here as a free-standing namespace so iOS unit
/// tests have a stable surface to call into without the SwiftUI view's
/// `@MainActor` requirement.
enum TimelineRowBuilder {
    enum TimelineRow: Identifiable, Equatable {
        case agentMessage(id: String, content: String)
        case userMessage(id: String, content: String)
        case toolCall(id: String, toolCallId: String, title: String, kind: String?, status: String?)
        case plan(id: String, items: [PlanItem])
        case thought(id: String, content: String)

        var id: String {
            switch self {
            case .agentMessage(let id, _),
                 .userMessage(let id, _),
                 .toolCall(let id, _, _, _, _),
                 .plan(let id, _),
                 .thought(let id, _):
                return id
            }
        }
    }

    struct PlanItem: Equatable {
        let text: String
        let isComplete: Bool
    }

    /// Build the timeline rows for the given event stream. See the macOS
    /// `ACPSessionDetailView.buildRows(events:)` doc comment for the full
    /// contract — this is a faithful port, intentionally verbatim so the
    /// two platforms stay in sync.
    static func buildRows(events: [ACPSessionUpdateMessage]) -> [TimelineRow] {
        var rows: [TimelineRow] = []
        var toolCallRowIndex: [String: Int] = [:]
        enum LastChunkKind { case agent, user, thought }
        var lastChunk: LastChunkKind? = nil

        for event in events {
            switch event.updateType {
            case .agentMessageChunk:
                let content = event.content ?? ""
                if lastChunk == .agent, case .agentMessage(let id, let prior) = rows.last {
                    rows[rows.count - 1] = .agentMessage(id: id, content: prior + content)
                } else {
                    rows.append(.agentMessage(id: event.id.uuidString, content: content))
                    lastChunk = .agent
                }
            case .userMessageChunk:
                let content = event.content ?? ""
                if lastChunk == .user, case .userMessage(let id, let prior) = rows.last {
                    rows[rows.count - 1] = .userMessage(id: id, content: prior + content)
                } else {
                    rows.append(.userMessage(id: event.id.uuidString, content: content))
                    lastChunk = .user
                }
            case .agentThoughtChunk:
                let content = event.content ?? ""
                if lastChunk == .thought, case .thought(let id, let prior) = rows.last {
                    rows[rows.count - 1] = .thought(id: id, content: prior + content)
                } else {
                    rows.append(.thought(id: event.id.uuidString, content: content))
                    lastChunk = .thought
                }
            case .toolCall:
                lastChunk = nil
                let toolCallId = event.toolCallId ?? event.id.uuidString
                let title = event.toolTitle ?? toolCallId
                let row = TimelineRow.toolCall(
                    id: event.id.uuidString,
                    toolCallId: toolCallId,
                    title: title,
                    kind: event.toolKind,
                    status: event.toolStatus
                )
                toolCallRowIndex[toolCallId] = rows.count
                rows.append(row)
            case .toolCallUpdate:
                lastChunk = nil
                guard let toolCallId = event.toolCallId,
                      let rowIndex = toolCallRowIndex[toolCallId],
                      case .toolCall(let id, _, let title, let kind, _) = rows[rowIndex]
                else {
                    continue
                }
                rows[rowIndex] = .toolCall(
                    id: id,
                    toolCallId: toolCallId,
                    title: event.toolTitle ?? title,
                    kind: event.toolKind ?? kind,
                    status: event.toolStatus
                )
            case .plan:
                lastChunk = nil
                let items = parsePlanItems(event.content ?? "")
                rows.append(.plan(id: event.id.uuidString, items: items))
            case .unknown:
                continue
            }
        }
        return rows
    }

    /// Parses the `content` payload of a `.plan` update into checklist
    /// items. Mirrors the macOS contract:
    /// 1. JSON object/array with `items: [{ text, status }]`.
    /// 2. JSON array of `{ text, status }` rows.
    /// 3. Markdown-style checklist lines (`- [x] foo` / `- [ ] bar`).
    /// 4. Plain bulleted lines (`- foo`) — treated as incomplete.
    /// 5. Anything else falls through as a single-item plan with the raw
    ///    text, so a malformed payload still renders something legible.
    static func parsePlanItems(_ content: String) -> [PlanItem] {
        let trimmed = content.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return [] }

        if let data = trimmed.data(using: .utf8),
           let parsed = try? JSONSerialization.jsonObject(with: data) {
            if let items = parsePlanJSON(parsed) {
                return items
            }
        }

        var items: [PlanItem] = []
        for line in trimmed.components(separatedBy: .newlines) {
            let lineTrim = line.trimmingCharacters(in: .whitespaces)
            if lineTrim.isEmpty { continue }
            if let item = parseChecklistLine(lineTrim) {
                items.append(item)
            } else {
                items.append(PlanItem(text: lineTrim, isComplete: false))
            }
        }
        return items.isEmpty ? [PlanItem(text: trimmed, isComplete: false)] : items
    }

    private static func parsePlanJSON(_ value: Any) -> [PlanItem]? {
        if let array = value as? [Any] {
            return array.compactMap { entry in
                if let dict = entry as? [String: Any], let text = dict["text"] as? String {
                    return PlanItem(text: text, isComplete: planItemIsComplete(dict["status"]))
                }
                if let str = entry as? String {
                    return PlanItem(text: str, isComplete: false)
                }
                return nil
            }
        }
        if let dict = value as? [String: Any], let items = dict["items"] {
            return parsePlanJSON(items)
        }
        return nil
    }

    private static func planItemIsComplete(_ status: Any?) -> Bool {
        guard let raw = status as? String else { return false }
        switch raw.lowercased() {
        case "completed", "complete", "done": return true
        default: return false
        }
    }

    private static func parseChecklistLine(_ line: String) -> PlanItem? {
        let lower = line.lowercased()
        // Order matters: check `- [x]` / `- [ ]` first because they look
        // like a bulleted line too.
        if lower.hasPrefix("- [x]") || lower.hasPrefix("* [x]") || lower.hasPrefix("[x]") {
            let stripped = line.drop(while: { $0 != "]" }).dropFirst()
            return PlanItem(
                text: String(stripped).trimmingCharacters(in: .whitespaces),
                isComplete: true
            )
        }
        if lower.hasPrefix("- [ ]") || lower.hasPrefix("* [ ]") || lower.hasPrefix("[ ]") {
            let stripped = line.drop(while: { $0 != "]" }).dropFirst()
            return PlanItem(
                text: String(stripped).trimmingCharacters(in: .whitespaces),
                isComplete: false
            )
        }
        if line.hasPrefix("- ") || line.hasPrefix("* ") {
            return PlanItem(
                text: String(line.dropFirst(2)).trimmingCharacters(in: .whitespaces),
                isComplete: false
            )
        }
        return nil
    }
}

// Convenience alias so the SwiftUI body's switch reads naturally without
// the `TimelineRowBuilder.` prefix on every case.
typealias TimelineRow = TimelineRowBuilder.TimelineRow

// MARK: - Scroll Offset Plumbing

/// Publishes the timeline's content `minY` through a `PreferenceKey` so the
/// parent can observe scroll direction without dropping into UIKit gesture
/// recognizers.
private struct ACPSessionDetailIOSScrollOffsetKey: PreferenceKey {
    static var defaultValue: CGFloat = 0
    static func reduce(value: inout CGFloat, nextValue: () -> CGFloat) {
        value = nextValue()
    }
}
#endif
