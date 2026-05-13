import SwiftUI
import VellumAssistantShared

// MARK: - ACPSessionDetailView

/// Detail view of an ACP (Agent Client Protocol) session.
///
/// Renders a header (agent + status + elapsed + parent-conversation link), a
/// scrolling timeline of `ACPSessionUpdateMessage` events grouped into visual
/// rows, and a context-sensitive footer: a steering textbox+button for
/// running sessions, or a "Delete from history" button once the session is
/// terminal. Tool calls coalesce with their `tool_call_update` siblings
/// (latest update wins) so a streaming tool that emits multiple status
/// transitions still renders as a single row.
///
/// Auto-scrolls to the latest event while the user is parked at the bottom;
/// pauses auto-scroll once the user scrolls up so they can read past content
/// without being yanked back. Resumes when the user returns to the bottom.
///
/// A Cancel button surfaces while the session is `running`/`initializing`
/// (PR 24); a Steer textbox + button surfaces while the session is `running`
/// (PR 25); a "Delete from history" button surfaces once the session is
/// terminal (PR 26).
struct ACPSessionDetailView: View {
    let session: ACPSessionViewModel
    /// Store used to drive optimistic mutations from this view (cancel,
    /// steer, delete). Held by reference so the view always invokes the
    /// caller-owned instance — there's only one ``ACPSessionStore`` per app.
    let store: ACPSessionStore
    /// Tap on the parent-conversation link. Wired by PR 22; nil hides the link.
    var onSelectParentConversation: ((String) -> Void)? = nil
    /// Optional close action — surfaces the design-system close button when
    /// this view is hosted inside a panel container that can dismiss itself.
    var onClose: (() -> Void)? = nil
    /// Pop-to-list callback fired after a successful "Delete from history".
    /// Hosting view (the panel's `NavigationStack`) is responsible for the
    /// actual back-pop; we just signal that the underlying row is gone.
    /// When unset, we fall back to the environment's `dismiss` action so a
    /// successful delete always returns the user to the list.
    var onDismiss: (() -> Void)? = nil

    /// Fallback dismiss action used when no explicit `onDismiss` callback is
    /// wired by the host. Resolves to the enclosing `NavigationStack`'s
    /// pop action when this view is pushed via `navigationDestination`.
    @Environment(\.dismiss) private var dismissEnvironment

    /// True while a cancel HTTP request is in flight. Disables the button and
    /// shows an inline spinner so the user can't double-tap.
    @State private var cancelInFlight = false

    /// Sentinel ID anchored at the bottom of the LazyVStack so the
    /// `ScrollViewReader` can scroll to "the latest" without depending on
    /// per-event identity (which churns as the events array mutates).
    private static let bottomAnchorId = "ACPSessionDetail.bottomAnchor"

    /// True while auto-scroll is active. Flipped to false the moment the
    /// user scrolls upward, and back to true once they return to the bottom.
    @State private var autoScrollEnabled = true
    /// Last observed scroll offset reported by the timeline, used to detect
    /// the direction of the most recent user-driven scroll.
    @State private var lastScrollOffset: CGFloat = 0
    /// Last observed bottom offset (content height − viewport height).
    /// Compared against `lastScrollOffset` to decide whether the user is
    /// currently parked at the bottom.
    @State private var lastMaxScrollOffset: CGFloat = 0
    /// Wall clock used to refresh the elapsed time once per second while the
    /// session is still running. The view only reads it when the session is
    /// non-terminal so terminal sessions don't wake the timer.
    @State private var nowTick: Date = Date()
    /// Bound text content of the steer textbox. Cleared on every successful
    /// submission so the field is ready for the next instruction.
    @State private var steerInput: String = ""
    /// True while a "Delete from history" request is in flight. Gates the
    /// button so a flurry of taps can't spawn duplicate requests.
    @State private var isDeleting = false

    /// Persisted preference for whether agent-thought bubbles render in the
    /// timeline. Defaults to `true` so first-time users see the assistant's
    /// reasoning surface without hunting for a toggle. Persists across
    /// detail-view re-opens via `@AppStorage`.
    @AppStorage("acp.showThoughts") private var showThoughts: Bool = true

    private static let elapsedTickInterval: TimeInterval = 1
    private static let scrollAtBottomTolerance: CGFloat = 4

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
    }

    // MARK: - Header

    @ViewBuilder
    private var header: some View {
        VStack(alignment: .leading, spacing: VSpacing.sm) {
            HStack(alignment: .center, spacing: VSpacing.sm) {
                Text(ACPSessionStateFormatter.agentLabel(for: session.state.agentId))
                    .font(VFont.titleSmall)
                    .foregroundStyle(VColor.contentDefault)
                    .lineLimit(1)
                statusPill
                Spacer()
                if isCancelable {
                    cancelControl
                }
                if let onClose {
                    VButton(label: "Close", iconOnly: "xmark", style: .ghost, action: onClose)
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
    /// timeline. The lightbulb icon doubles as a glance-affordance so the
    /// row reads as "thoughts on/off" without a separate help string.
    /// Accessibility is delegated to `VToggle`, which already publishes
    /// the on/off value and a tap trait — wrapping it again would produce
    /// duplicate VoiceOver announcements.
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
    /// `internal` rather than `private` so unit tests in `VellumAssistantLib`
    /// can verify the gating without rendering the view.
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
            .accessibilityLabel("Cancel session")
        }
    }

    /// `internal` rather than `private` so unit tests in `VellumAssistantLib`
    /// can drive the cancel flow without reaching into SwiftUI's view tree.
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
            label: ACPSessionStateFormatter.statusLabel(session.state.status),
            tone: statusTone(session.state.status),
            emphasis: .subtle
        )
        .accessibilityLabel("Status: \(ACPSessionStateFormatter.statusLabel(session.state.status))")
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
        }
        .buttonStyle(.plain)
        .accessibilityLabel("Open parent conversation")
    }

    // MARK: - Timeline

    @ViewBuilder
    private var timeline: some View {
        let allRows = Self.buildRows(events: session.events)
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
                    // Read the scroll position via the bounds of the inner
                    // content. .named("acp-timeline") matches the coordinate
                    // space declared on the ScrollView below.
                    .background(scrollOffsetReader)
                }
                .coordinateSpace(name: "acp-timeline")
                .onPreferenceChange(ACPSessionDetailScrollOffsetKey.self) { contentMinY in
                    handleScrollOffsetChange(contentMinY)
                }
                .onChange(of: session.events.last?.id) {
                    // `events.count` plateaus at `ACPSessionStore.eventsCapPerSession`
                    // (the ring buffer trims oldest entries on append), so a count-keyed
                    // `.onChange` would silently stop firing for long sessions. Observe
                    // the last event's id instead — each `ACPSessionUpdateMessage`
                    // carries a unique UUID, so this fires on every append.
                    if autoScrollEnabled {
                        // .easeOut keeps the jump readable when many events
                        // arrive at once.
                        withAnimation(.easeOut(duration: 0.1)) {
                            proxy.scrollTo(Self.bottomAnchorId, anchor: .bottom)
                        }
                    }
                }
                .onChange(of: session.events.first?.id) {
                    // Oldest event changed — content was trimmed from the head of
                    // the ring buffer, which shrinks total content height and shifts
                    // the offset baseline. Without resetting the watermark here,
                    // `returnedToBottom` would never be satisfied again (the stored
                    // max stays beyond the new actual bottom) and auto-scroll would
                    // permanently lock out. The next offset reading re-establishes
                    // both values for the now-shorter content.
                    lastMaxScrollOffset = 0
                    lastScrollOffset = 0
                }
                .onChange(of: showThoughts) {
                    // Toggling thought visibility shrinks/grows the timeline,
                    // which moves the bottom offset. Reset the watermark for
                    // the same reason as the ring-buffer trim above and
                    // re-engage auto-scroll so users who flip the toggle while
                    // parked at the bottom keep getting new events pinned.
                    lastMaxScrollOffset = 0
                    lastScrollOffset = 0
                    autoScrollEnabled = true
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
    /// without resorting to AppKit gesture recognizers.
    @ViewBuilder
    private var scrollOffsetReader: some View {
        GeometryReader { geo in
            // The inner content's `minY` in the named coordinate space goes
            // negative as the user scrolls down. We publish it as-is and
            // negate at the consumer to get a positive "offset from top".
            Color.clear.preference(
                key: ACPSessionDetailScrollOffsetKey.self,
                value: geo.frame(in: .named("acp-timeline")).minY
            )
        }
    }

    private func handleScrollOffsetChange(_ contentMinY: CGFloat) {
        // We don't know the viewport height inside the preference reader, so
        // we infer "user is at the bottom" by tracking the largest offset
        // we've seen — that value matches the bottom whenever the user is
        // already there. A jump *upward* from the previous offset pauses
        // auto-scroll; a return to the high-water mark resumes it.
        let currentOffset = -contentMinY
        defer { lastScrollOffset = currentOffset }

        let movedUp = currentOffset < lastScrollOffset - Self.scrollAtBottomTolerance
        // Evaluate against the *prior* high-water mark, before bumping it.
        // If we updated the mark first, any offset that exceeds it (e.g. the
        // user scrolling partway down into newly-arrived content) would
        // immediately satisfy `abs(0) < tolerance` and re-engage auto-scroll
        // — yanking the user away from where they were reading.
        let returnedToBottom = abs(currentOffset - lastMaxScrollOffset) < Self.scrollAtBottomTolerance

        if currentOffset > lastMaxScrollOffset {
            lastMaxScrollOffset = currentOffset
        }

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
                MarkdownSegmentView(segments: parseMarkdownSegments(content))
                    .equatable()
                    .textSelection(.enabled)
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
        // Daemon emits lowercase status strings (`pending`, `running`,
        // `completed`, `failed`, etc). Display-cased here so the pill reads
        // naturally without forcing every UI consumer to title-case.
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
        // Map the well-known ACP tool kinds to design-system icons. Unknown
        // kinds fall back to a generic wrench so a future server-side kind
        // addition still renders as something recognisably tool-shaped.
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
    private func planChecklist(items: [PlanItem]) -> some View {
        // Use HStack + Spacer to take leading width without spawning a
        // `_FlexFrameLayout` inside the LazyVStack cell — see
        // `clients/macos/AGENTS.md` § "No .frame(maxWidth:) in LazyVStack".
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
        // Italicised + secondary-tone bubble distinguishes the agent's
        // internal reasoning from spoken output. The lightbulb icon doubles
        // as an affordance — a glance tells the user "this is a thought,
        // not a message" before they read the text.
        HStack(spacing: 0) {
            HStack(alignment: .top, spacing: VSpacing.xs) {
                VIconView(.lightbulb, size: 12)
                    .foregroundStyle(VColor.contentTertiary)
                    .padding(.top, 2)
                Text(content)
                    .font(VFont.bodyMediumDefault.italic())
                    .foregroundStyle(VColor.contentTertiary)
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
            VTextField(
                placeholder: "Redirect this agent…",
                text: $steerInput,
                onSubmit: dispatchSteer
            )
            VButton(
                label: "Steer",
                style: .primary,
                isDisabled: steerInput.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
                action: dispatchSteer
            )
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
    /// The textbox is cleared by the caller (the SwiftUI footer) before this
    /// runs — that keeps `steerInput`'s `@State` mutation on the rendering
    /// path, which is also where SwiftUI requires it. Tests can call this
    /// helper directly with the desired pre-trim string and assert the spy
    /// store recorded the trimmed instruction, without relying on `@State`
    /// semantics in a detached view value.
    ///
    /// `internal` rather than `private` so unit tests in `VellumAssistantLib`
    /// can drive submission without round-tripping through SwiftUI focus
    /// state — there is no supported way to programmatically tap a `Button`
    /// in an XCTest unit target.
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
        let id = session.state.id
        let acpSessionId = session.state.acpSessionId
        Task { @MainActor in
            let result = await store.steer(id: id, instruction: instruction)
            // Surface a failure follow-up so the optimistic "→ steered: …"
            // row above isn't misread as confirmation when the daemon
            // rejected the instruction (transport error, session ended, etc.).
            if case .failure = result {
                session.appendEvent(ACPSessionUpdateMessage(
                    acpSessionId: acpSessionId,
                    updateType: .userMessageChunk,
                    content: "→ steer failed — the session may have ended."
                ))
            }
        }
    }

    // MARK: - Delete Footer

    /// Delete-from-history is only meaningful once the session has reached a
    /// terminal status. The daemon also enforces this with a 409 on active
    /// sessions, so gating the button is purely about avoiding a confusing
    /// affordance that would always fail.
    ///
    /// `internal` rather than `private` so unit tests in `VellumAssistantLib`
    /// can verify the gating without rendering the view.
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
            .accessibilityLabel("Delete session from history")
        }
        .padding(EdgeInsets(top: VSpacing.md, leading: VSpacing.lg, bottom: VSpacing.md, trailing: VSpacing.lg))
    }

    /// `internal` rather than `private` so unit tests in `VellumAssistantLib`
    /// can drive the delete flow without reaching into SwiftUI's view tree.
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
                    dismissEnvironment()
                }
            }
        }
    }
}

// MARK: - Timeline Row Model

extension ACPSessionDetailView {
    /// A single visual row in the timeline. Tool-call updates fold into
    /// their parent `.toolCall` row (latest status wins); `.unknown` events
    /// are dropped silently. The `id` is stable per row so SwiftUI's diffing
    /// reuses the same view across re-renders.
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

    /// Build the timeline rows for the given event stream.
    ///
    /// - Tool-call updates (`.toolCallUpdate`) are folded onto the matching
    ///   `.toolCall` row by `toolCallId` so the row's `status` reflects the
    ///   latest update rather than the original one.
    /// - Consecutive same-role chunk events (`agent_message_chunk`,
    ///   `user_message_chunk`, `agent_thought_chunk`) are concatenated so
    ///   the timeline shows one bubble per logical message rather than one
    ///   per token.
    /// - `.unknown` and `toolCallUpdate` standalone are not emitted.
    static func buildRows(events: [ACPSessionUpdateMessage]) -> [TimelineRow] {
        var rows: [TimelineRow] = []
        // Index of the row in `rows` for each toolCallId we've already
        // emitted, so we can rewrite the status in-place when an update
        // arrives.
        var toolCallRowIndex: [String: Int] = [:]
        // Track the role of the last *chunk* row so we can append to it
        // instead of emitting a new row for the next token.
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
                    // Update arrived without a matching parent — drop it.
                    // The parent could have been dropped from the events
                    // ring buffer; surfacing a standalone "update" row
                    // would be confusing.
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
                // Tolerated by design — ACP allows unknown updateType
                // values; rather than crashing or showing a placeholder we
                // drop them silently.
                continue
            }
        }
        return rows
    }

    /// Parses the `content` payload of a `.plan` update into checklist
    /// items. The wire shape is intentionally loose (free-form string from
    /// the daemon), so we accept a small handful of common formats:
    ///
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

// MARK: - Scroll Offset Plumbing

/// Publishes the timeline's content `minY` through a `PreferenceKey` so the
/// parent can observe scroll direction without dropping into AppKit gesture
/// recognizers. The value is the inner content's frame origin in the named
/// coordinate space — negative once scrolled past the top.
private struct ACPSessionDetailScrollOffsetKey: PreferenceKey {
    static var defaultValue: CGFloat = 0
    static func reduce(value: inout CGFloat, nextValue: () -> CGFloat) {
        value = nextValue()
    }
}
