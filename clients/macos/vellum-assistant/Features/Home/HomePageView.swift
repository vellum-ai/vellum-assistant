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
/// The split layout (detail panel) is now handled by ``VSplitView``
/// at the ``PanelCoordinator`` level, matching the pattern used by
/// SubagentDetailPanel and DocumentEditorPanelView.
struct HomePageView: View {
    @Bindable var store: HomeStore
    @Bindable var feedStore: HomeFeedStore
    @Bindable var meetStatusViewModel: MeetStatusViewModel
    let onFeedConversationOpened: (String) -> Void
    let onStartNewChat: () -> Void
    let onDismissSuggestions: () -> Void
    let onSuggestionSelected: (HomeSuggestion) -> Void
    var onDetailPanelSelected: (FeedItem) -> Void = { _ in }

    @AppStorage("homeSuggestionsDismissed") private var suggestionsDismissed: Bool = false
    @State private var activeFilter: FeedItemCategory? = nil

    private let maxContentWidth: CGFloat = 960

    var body: some View {
        Group {
            if let state = store.state {
                content(for: state)
            } else {
                skeleton
            }
        }
        .background(VColor.surfaceBase)
        .onChange(of: presentCategories) { _, cats in
            if let active = activeFilter, !cats.contains(active) {
                activeFilter = nil
            }
        }
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
                    activeFilter: activeFilter,
                    presentCategories: presentCategories,
                    onFilterChanged: { activeFilter = $0 }
                )

                if groupedFeed.isEmpty, activeFilter != nil {
                    HStack {
                        Spacer(minLength: 0)
                        Text("No notifications")
                            .font(VFont.bodyMediumDefault)
                            .foregroundStyle(VColor.contentTertiary)
                        Spacer(minLength: 0)
                    }
                    .padding(.vertical, VSpacing.xxl)
                }

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
                                        },
                                        // Mirror HomeRecapRow's dismiss affordance on the parent and
                                        // each child so grouped rows aren't sticky in the feed
                                        // (Codex P2 + Devin feedback on PR #27475).
                                        onParentDismiss: { dismissItem(parent) },
                                        onChildDismiss: { child in
                                            if let feedChild = children.first(where: { $0.id == child.id }) {
                                                dismissItem(feedChild)
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

    /// Categories present in the visible feed (non-dismissed, non-high-urgency).
    /// Drives the filter bar — only categories with items get a pill.
    private var presentCategories: Set<FeedItemCategory> {
        var cats = Set<FeedItemCategory>()
        for item in feedStore.items {
            guard item.status != .dismissed else { continue }
            if item.urgency == .high || item.urgency == .critical { continue }
            cats.insert(item.category ?? .system)
        }
        return cats
    }

    /// Sorts the feed by `priority desc, createdAt desc`, hides
    /// dismissed items (so `dismissItem(_:)` gives immediate feedback
    /// without waiting for a server refresh to rewrite the array),
    /// buckets via `HomeFeedTimeGroup.bucket(_:)`, then collapses
    /// contiguous low-priority digest runs within each bucket via
    /// `HomeFeedGrouping.group(_:)`.
    // Exposed for HomePageViewGroupingTests — kept out of public API via no-op accessor; grouping is a behavior that benefits from direct unit testing.
    var groupedFeed: [(group: HomeFeedTimeGroup, rows: [HomeFeedGroupedRow])] {
        let sorted = feedStore.items.sorted { a, b in
            if a.priority != b.priority { return a.priority > b.priority }
            return a.createdAt > b.createdAt
        }
        let filtered = sorted.filter { item in
            guard item.status != .dismissed else { return false }
            // High/critical urgency items are surfaced as macOS system
            // notifications instead of appearing in the feed.
            if item.urgency == .high || item.urgency == .critical { return false }
            if let active = activeFilter {
                return (item.category ?? .system) == active
            }
            return true
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

    /// Icon glyph for a feed item, dispatched per `FeedItemCategory`.
    /// Falls back to `.bell` for items without a category.
    private func icon(for item: FeedItem) -> VIcon {
        switch item.category {
        case .security:    return .shieldCheck
        case .email:       return .mail
        case .scheduling:  return .clock
        case .background:  return .settings
        case .system:      return .bell
        case nil:          return .bell
        }
    }

    /// Foreground (glyph) color for the recap icon, dispatched per
    /// `FeedItemCategory`. Uses feed-specific semantic tokens from
    /// `ColorTokens.swift`.
    private func iconForeground(for item: FeedItem) -> Color {
        switch item.category {
        case .security:    return VColor.feedNudgeStrong
        case .email:       return VColor.feedDigestStrong
        case .scheduling:  return VColor.feedThreadStrong
        case .background:  return VColor.systemInfoStrong
        case .system:      return VColor.feedDigestStrong
        case nil:          return VColor.feedDigestStrong
        }
    }

    /// Background (circle fill) color for the recap icon, dispatched per
    /// `FeedItemCategory`.
    private func iconBackground(for item: FeedItem) -> Color {
        switch item.category {
        case .security:    return VColor.feedNudgeWeak
        case .email:       return VColor.feedDigestWeak
        case .scheduling:  return VColor.feedThreadWeak
        case .background:  return VColor.systemInfoWeak
        case .system:      return VColor.feedDigestWeak
        case nil:          return VColor.feedDigestWeak
        }
    }

    // MARK: - Actions

    /// Opens the detail panel for the tapped feed item. Every item
    /// resolves to a panel kind via ``HomeDetailPanelKind.resolve(for:)``.
    func openItem(_ item: FeedItem) {
        onDetailPanelSelected(item)
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

