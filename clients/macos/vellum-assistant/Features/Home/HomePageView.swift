import SwiftUI
import VellumAssistantShared

/// Assembles the redesigned Home page: a centered editorial column with
/// three blocks — a greeting header (avatar + title + "New Chat" CTA), an
/// optional dismissible "have you tried…" suggestion bar, and a
/// time-grouped feed of recap rows (Today / Yesterday / Older).
///
/// This view is rendered inside the Home panel in ``PanelCoordinator``, so
/// it does NOT wrap itself in another page container.
///
/// The parent owns all navigation decisions — every CTA is a plain closure
/// plumbed through from the ``PanelCoordinator``. Loading is driven by
/// `store.load()` / `feedStore.load()` on appear; on transport failure
/// both stores keep the last-good state so we never blank the UI between
/// refreshes.
///
/// The view is generic over an optional trailing detail panel. When
/// `isDetailPanelVisible` is true and a non-empty `detailPanel` is
/// supplied, the body splits into a two-pane layout with the main home
/// content on the leading side and the supplied panel anchored to the
/// trailing edge. When false, the layout renders identically to the
/// single-column original.
struct HomePageView<DetailPanel: View>: View {
    @Bindable var store: HomeStore
    @Bindable var feedStore: HomeFeedStore
    /// Drives the "In meeting" status panel rendered at the top of the
    /// gallery. Owned by the parent so the panel survives panel-dismiss
    /// cycles and keeps its SSE subscription live for the whole session.
    @Bindable var meetStatusViewModel: MeetStatusViewModel
    /// Fired when a feed action resolves to a daemon-created conversation
    /// — the receiver (usually `PanelCoordinator`) navigates into it.
    let onFeedConversationOpened: (String) -> Void
    /// Fired when the "New Chat" pill in the greeting header is tapped.
    /// Routes to the same code path the sidebar's New-chat button hits.
    let onStartNewChat: () -> Void
    /// Fired when the user dismisses the suggestion bar. The view also
    /// hides the bar locally via `suggestionsDismissed`; this closure is
    /// a hook for future server-side persistence (currently a no-op at
    /// the call site — see PR note in the plan).
    let onDismissSuggestions: () -> Void
    /// Fired when the user taps one of the suggestion pills. The parent
    /// opens a fresh conversation seeded with the suggestion label.
    let onSuggestionSelected: (HomeSuggestion) -> Void
    /// Fired when the user taps a `.thread` (scheduled) feed item — the
    /// parent presents the scheduled detail panel instead of opening a
    /// conversation. All other item types keep the conversation flow.
    /// Defaults to a no-op so callers that don't need the scheduled-panel
    /// flow don't have to supply it (and the memberwise init stays usable
    /// from tests that only care about the detail-panel split).
    let onScheduledItemSelected: (FeedItem) -> Void = { _ in }
    /// Drives the two-pane split. When false, the home content renders in
    /// its original single-column layout and the `detailPanel` slot is
    /// ignored.
    var isDetailPanelVisible: Bool = false
    /// Trailing-edge slot. Callers supply a fully-constructed
    /// `HomeDetailPanel` (or any view) here; ownership of the panel's
    /// state stays with the caller.
    @ViewBuilder let detailPanel: () -> DetailPanel

    /// Local hide flag for the "have you tried…" bar. Flipped to `true`
    /// when the user taps the X affordance; stays true for the rest of
    /// this view's lifecycle so the bar doesn't reappear on state
    /// refresh. Persistent per-account dismissal is a follow-up.
    @State private var suggestionsDismissed: Bool = false

    /// Types the user has tapped in the filter bar. Empty means "show
    /// everything" — a non-empty set is treated as an inclusion filter
    /// in ``groupedFeed``. Deliberately view-local (not persisted):
    /// the filter is a transient read-time affordance, not a setting.
    @State private var activeFilter: FeedItemType? = nil

    /// Editorial column width. Bumped from 600pt to 960pt to match the
    /// Figma redesign — the new three-block layout reads as a wider page,
    /// not a narrow column.
    private let maxContentWidth: CGFloat = 960

    var body: some View {
        HStack(alignment: .top, spacing: isDetailPanelVisible ? VSpacing.lg : 0) {
            Group {
                if let state = store.state {
                    content(for: state)
                } else {
                    skeleton
                }
            }
            .frame(maxWidth: .infinity)

            if isDetailPanelVisible {
                detailPanel()
                    .transition(.move(edge: .trailing).combined(with: .opacity))
            }
        }
        .padding(isDetailPanelVisible ? VSpacing.lg : 0)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
        .background(VColor.surfaceBase)
        .animation(VAnimation.standard, value: isDetailPanelVisible)
        .task {
            await store.load()
            await feedStore.load()
        }
    }

    // MARK: - Content

    private func content(for state: RelationshipState) -> some View {
        ScrollView {
            VStack(alignment: .leading, spacing: VSpacing.xxl) {
                // "In meeting" status banner — returns EmptyView when idle,
                // so when no meeting is active the layout collapses to the
                // greeting-first appearance.
                MeetStatusPanel(viewModel: meetStatusViewModel)

                HomeGreetingHeader(
                    greeting: "Here's what's been going on",
                    onStartNewChat: onStartNewChat
                ) {
                    // Inline avatar rendering so this view owns its own
                    // avatar resolution without depending on other views.
                    greetingAvatar
                }
                .padding(.top, VSpacing.xxl)

                if !suggestionsDismissed, !currentSuggestions.isEmpty {
                    HomeSuggestionPillBar(
                        headline: "By the way, have you tried one of these:",
                        suggestions: currentSuggestions,
                        onSelect: onSuggestionSelected,
                        onDismiss: {
                            suggestionsDismissed = true
                            onDismissSuggestions()
                        }
                    )
                }

                HomeFeedFilterBar(
                    selected: activeFilter,
                    onToggle: { type in
                        // Single-select: tapping the active chip clears
                        // the filter; tapping a different chip replaces it.
                        activeFilter = (activeFilter == type) ? nil : type
                    }
                )

                ForEach(Array(groupedFeed.enumerated()), id: \.element.group) { _, bucket in
                    VStack(alignment: .leading, spacing: VSpacing.md) {
                        HomeFeedGroupHeader(label: bucket.group.label)
                        VStack(alignment: .leading, spacing: VSpacing.xs) {
                            ForEach(bucket.rows, id: \.id) { row in
                                switch row {
                                case .single(let item):
                                    HomeRecapRow(
                                        icon: icon(for: item),
                                        iconForeground: iconForeground(for: item),
                                        iconBackground: iconBackground(for: item),
                                        title: item.title,
                                        onDismiss: { dismissItem(item) },
                                        onTap: { openItem(item) }
                                    )
                                case .group(let parent, let children):
                                    HomeRecapGroupRow(
                                        parentIcon: icon(for: parent),
                                        parentIconForeground: iconForeground(for: parent),
                                        parentIconBackground: iconBackground(for: parent),
                                        parentTitle: parent.title,
                                        children: children.map { child in
                                            HomeRecapGroupRow.Child(
                                                id: child.id,
                                                icon: icon(for: child),
                                                iconForeground: iconForeground(for: child),
                                                iconBackground: iconBackground(for: child),
                                                title: child.title
                                            )
                                        },
                                        // Always-expanded matches Figma `3679:21591` which shows the
                                        // group's children already visible. Keeping expand/collapse as
                                        // an affordance conflicted with tap-to-open (Devin P1 feedback
                                        // on PR #27466 cycle 2) — any tap would either navigate away
                                        // (losing the expand affordance) or block open (making the
                                        // parent unreachable, Codex P2 cycle 1). Always-expanded keeps
                                        // both open-tap AND visible children.
                                        isExpanded: .constant(true),
                                        onParentTap: { openItem(parent) },
                                        onChildTap: { child in
                                            if let feedChild = children.first(where: { $0.id == child.id }) {
                                                openItem(feedChild)
                                            }
                                        }
                                    )
                                }
                            }
                        }
                    }
                }

                Spacer(minLength: VSpacing.xxl)
            }
            .frame(maxWidth: maxContentWidth, alignment: .top)
            .padding(.horizontal, VSpacing.xl)
            .padding(.bottom, VSpacing.xxl)
            .frame(maxWidth: .infinity, alignment: .top)
        }
    }

    // MARK: - Greeting avatar

    /// Inline avatar rendering so this view doesn't depend on another
    /// view's internals. 40pt sizing matches the Figma spec for the new
    /// greeting row.
    @ViewBuilder
    private var greetingAvatar: some View {
        let appearance = AvatarAppearanceManager.shared
        let avatarSize: CGFloat = 40
        if appearance.customAvatarImage != nil {
            VAvatarImage(
                image: appearance.fullAvatarImage,
                size: avatarSize,
                showBorder: false
            )
        } else if let bodyShape = appearance.characterBodyShape,
                  let eyes = appearance.characterEyeStyle,
                  let color = appearance.characterColor {
            AnimatedAvatarView(
                bodyShape: bodyShape,
                eyeStyle: eyes,
                color: color,
                size: avatarSize,
                entryAnimationEnabled: false
            )
            .frame(width: avatarSize, height: avatarSize)
        } else {
            VAvatarImage(
                image: appearance.fullAvatarImage,
                size: avatarSize,
                showBorder: false
            )
        }
    }

    // MARK: - Feed grouping

    /// Sorts the feed by `priority desc, createdAt desc`, hides
    /// dismissed items (so `dismissItem(_:)` gives immediate feedback
    /// without waiting for a server refresh to rewrite the array),
    /// applies the active type filter (nil = show all), buckets via
    /// `HomeFeedTimeGroup.bucket(_:)`, then collapses contiguous
    /// low-priority digest runs within each bucket via
    /// `HomeFeedGrouping.group(_:)`.
    // Exposed for HomePageViewGroupingTests — kept out of public API via no-op accessor; grouping is a behavior that benefits from direct unit testing.
    var groupedFeed: [(group: HomeFeedTimeGroup, rows: [HomeFeedGroupedRow])] {
        groupedFeed(for: activeFilter)
    }

    /// Pure grouping pipeline exposed for unit tests. Mirrors the logic
    /// used by ``groupedFeed`` but takes the filter as a parameter so
    /// tests don't need to manipulate `@State`.
    func groupedFeed(for filter: FeedItemType?) -> [(group: HomeFeedTimeGroup, rows: [HomeFeedGroupedRow])] {
        let sorted = feedStore.items.sorted { a, b in
            if a.priority != b.priority { return a.priority > b.priority }
            return a.createdAt > b.createdAt
        }
        let filtered = sorted.filter { item in
            item.status != .dismissed
                && (filter == nil || filter == item.type)
        }
        let buckets = HomeFeedTimeGroup.bucket(filtered)
        return buckets.map { bucket in
            (group: bucket.group, rows: HomeFeedGrouping.group(bucket.items))
        }
    }

    // MARK: - Suggestions

    /// Suggestion pills sourced from `HomeFeedResponse.suggestedPrompts`,
    /// capped at three. The daemon always returns an array (possibly
    /// empty), so there is no fallback path — an empty response collapses
    /// the pill bar entirely.
    private var currentSuggestions: [HomeSuggestion] {
        feedStore.suggestedPrompts.prefix(3).map { HomeSuggestion(from: $0) }
    }

    // MARK: - Recap row styling

    /// Icon glyph for a feed item, driven by type + source. Mapping
    /// follows the Figma spec:
    ///   nudge + assistant   → heart
    ///   action              → arrow-left (inbound intent)
    ///   digest              → bell
    ///   thread              → calendar (aligned with the Schedule
    ///                                    filter chip so row icons
    ///                                    and chips share one visual
    ///                                    language)
    private func icon(for item: FeedItem) -> VIcon {
        switch item.type {
        case .nudge:
            // Assistant-authored nudges are the canonical heart case; any
            // other source falls through to the same glyph — there is no
            // non-assistant nudge variant in the spec today.
            return .heart
        case .action:
            return .arrowLeft
        case .digest:
            return .bell
        case .thread:
            return .calendar
        }
    }

    /// Foreground (glyph) color for the recap icon. Each feed type maps
    /// to its dedicated Figma identifier pair (pink / blue / teal /
    /// amber) — see the `feed*` and `systemInfo*` tokens in
    /// `ColorTokens.swift`. Rows and filter chips share one source of
    /// truth so the visual language stays consistent.
    private func iconForeground(for item: FeedItem) -> Color {
        switch item.type {
        case .nudge:   return VColor.feedNudgeStrong
        case .action:  return VColor.systemInfoStrong
        case .digest:  return VColor.feedDigestStrong
        case .thread:  return VColor.feedThreadStrong
        }
    }

    /// Background (circle fill) color for the recap icon.
    private func iconBackground(for item: FeedItem) -> Color {
        switch item.type {
        case .nudge:   return VColor.feedNudgeWeak
        case .action:  return VColor.systemInfoWeak
        case .digest:  return VColor.feedDigestWeak
        case .thread:  return VColor.feedThreadWeak
        }
    }

    // MARK: - Actions

    /// Opens the feed item. For `.thread` (scheduled) items the parent
    /// presents a detail panel via `onScheduledItemSelected`; for every
    /// other type we preserve the existing "trigger the `open` action and
    /// navigate into the resulting conversation" flow. The daemon
    /// interprets any unknown action id as an "open" intent and seeds the
    /// new conversation with the first available action's prompt (or the
    /// item summary if there are no actions).
    ///
    /// Exposed as `internal` (not `private`) so routing tests can drive it
    /// directly without needing to render the full view tree.
    func openItem(_ item: FeedItem) {
        if item.type == .thread {
            onScheduledItemSelected(item)
            return
        }
        Task {
            if let conversationId = await feedStore.triggerAction(
                itemId: item.id,
                actionId: "open"
            ) {
                onFeedConversationOpened(conversationId)
            }
        }
    }

    /// Dismisses the feed item — store optimistically removes it from
    /// `items` and PATCHes the daemon with status `.dismissed`. The
    /// row disappears from the feed without any further UI.
    private func dismissItem(_ item: FeedItem) {
        Task {
            await feedStore.dismiss(itemId: item.id)
        }
    }

    // MARK: - Skeleton

    /// Skeleton silhouette that mirrors the new three-block layout:
    /// a greeting row (avatar + title bone), the "have you tried…"
    /// suggestion bar (rounded 16pt pill bar, ~60pt tall), and a single
    /// "Today" group header with three 48pt recap bones. Designed so the
    /// first paint doesn't shift when real data lands.
    private var skeleton: some View {
        VStack(alignment: .leading, spacing: VSpacing.xxl) {
            // Greeting row: avatar + title bone + New Chat CTA bone
            HStack(spacing: VSpacing.md) {
                VSkeletonBone(width: 40, height: 40, radius: 20)
                VSkeletonBone(width: 280, height: 28)
                Spacer()
                VSkeletonBone(width: 96, height: 32, radius: VRadius.md)
            }
            .padding(.top, VSpacing.xxl)

            // Suggestion bar
            VSkeletonBone(height: 72, radius: VRadius.xl)

            // First time group: "Today" label + three recap-row bones.
            // Mirrors the real content nesting: outer md-spaced stack
            // separates the group header from the inner rows sub-stack,
            // which uses xs spacing between rows.
            VStack(alignment: .leading, spacing: VSpacing.md) {
                VSkeletonBone(width: 60, height: 12)
                VStack(alignment: .leading, spacing: VSpacing.xs) {
                    VSkeletonBone(height: 48, radius: VRadius.md)
                    VSkeletonBone(height: 48, radius: VRadius.md)
                    VSkeletonBone(height: 48, radius: VRadius.md)
                }
            }
        }
        .frame(maxWidth: maxContentWidth, alignment: .top)
        .padding(.horizontal, VSpacing.xl)
        .padding(.bottom, VSpacing.xxl)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
    }
}

// MARK: - Backward-compatible convenience init

/// Default specialization used by every call site that doesn't opt into
/// the split layout. The `detailPanel` closure returns `EmptyView`, and
/// `isDetailPanelVisible` defaults to false so the single-column layout
/// is rendered unchanged.
extension HomePageView where DetailPanel == EmptyView {
    init(
        store: HomeStore,
        feedStore: HomeFeedStore,
        meetStatusViewModel: MeetStatusViewModel,
        onFeedConversationOpened: @escaping (String) -> Void,
        onStartNewChat: @escaping () -> Void,
        onDismissSuggestions: @escaping () -> Void,
        onSuggestionSelected: @escaping (HomeSuggestion) -> Void,
        onScheduledItemSelected: @escaping (FeedItem) -> Void = { _ in }
    ) {
        self.init(
            store: store,
            feedStore: feedStore,
            meetStatusViewModel: meetStatusViewModel,
            onFeedConversationOpened: onFeedConversationOpened,
            onStartNewChat: onStartNewChat,
            onDismissSuggestions: onDismissSuggestions,
            onSuggestionSelected: onSuggestionSelected,
            onScheduledItemSelected: onScheduledItemSelected,
            isDetailPanelVisible: false,
            detailPanel: { EmptyView() }
        )
    }
}
