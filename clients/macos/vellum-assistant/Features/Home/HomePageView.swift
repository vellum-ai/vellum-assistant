import SwiftUI
import VellumAssistantShared

/// Assembles the redesigned Home page: a centered editorial column with
/// three blocks — a greeting header (avatar + "New Chat" CTA), an
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
    @State private var isActivityExpanded: Bool = false
    @State private var isDismissedExpanded: Bool = false

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
                    onStartNewChat: onStartNewChat,
                    greeting: feedStore.contextBanner?.greeting,
                    name: store.state?.assistantName
                ) {
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

                if feedBuckets.isEmpty, activeFilter != nil {
                    HStack {
                        Spacer(minLength: 0)
                        Text("No notifications")
                            .font(VFont.bodyMediumDefault)
                            .foregroundStyle(VColor.contentTertiary)
                        Spacer(minLength: 0)
                    }
                    .padding(.vertical, VSpacing.xxl)
                }

                ForEach(Array(feedBuckets.enumerated()), id: \.element.group) { _, bucket in
                    VStack(alignment: .leading, spacing: VSpacing.md) {
                        HomeFeedGroupHeader(label: bucket.group.label)
                        VStack(alignment: .leading, spacing: VSpacing.xs) {
                            ForEach(bucket.items, id: \.id) { item in
                                recapRow(for: item, showsUrgency: true)
                            }
                        }
                    }
                }

                // Quieter hint when the inbox has nothing new but the
                // activity section has items — nudges the user toward the
                // disclosure without claiming the full empty-state space.
                // Suppressed when the user is actively filtering (the
                // filter-specific "No notifications" message above is the
                // right copy for that case).
                if inboxItems.isEmpty, activeFilter == nil, !activityItems.isEmpty {
                    Text("Nothing new — check Background activity")
                        .font(VFont.bodySmallDefault)
                        .foregroundStyle(VColor.contentTertiary)
                }

                DisclosureGroup(isExpanded: $isActivityExpanded) {
                    VStack(alignment: .leading, spacing: VSpacing.xs) {
                        ForEach(activityItems, id: \.id) { item in
                            recapRow(for: item, showsUrgency: false)
                        }
                    }
                    .padding(.top, VSpacing.sm)
                } label: {
                    Text("Background activity (\(activityItems.count))")
                        .font(VFont.bodySmallDefault)
                        .foregroundStyle(VColor.contentTertiary)
                }

                if !dismissedItems.isEmpty {
                    DisclosureGroup(isExpanded: $isDismissedExpanded) {
                        VStack(alignment: .leading, spacing: VSpacing.xs) {
                            ForEach(dismissedItems, id: \.id) { item in
                                recapRow(
                                    for: item,
                                    showsUrgency: false,
                                    trailingAction: .restore,
                                    onTrailing: { restoreItem(item) }
                                )
                            }
                        }
                        .padding(.top, VSpacing.sm)
                    } label: {
                        Text("Dismissed (\(dismissedItems.count))")
                            .font(VFont.bodySmallDefault)
                            .foregroundStyle(VColor.contentTertiary)
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
    /// view's internals. 56pt sizing gives the greeting row visual weight
    /// alongside the display-name heading.
    @ViewBuilder
    private var greetingAvatar: some View {
        let appearance = AvatarAppearanceManager.shared
        let avatarSize: CGFloat = 56
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

    /// True for items the inbox surfaces with a leading red dot — `urgency`
    /// of `.high` or `.critical`.
    private func isUrgent(_ item: FeedItem) -> Bool {
        item.urgency == .high || item.urgency == .critical
    }

    /// Non-dismissed feed items the server flagged as worth surfacing in the
    /// primary Inbox — `noteworthy == true`. Drives both `feedBuckets` and
    /// `presentCategories`.
    private var inboxItems: [FeedItem] {
        feedStore.items.filter { $0.status != .dismissed && $0.noteworthy == true }
    }

    /// Non-dismissed feed items that didn't earn an inbox slot — everything
    /// with `noteworthy != true` (including `nil`, so legacy items without
    /// the field default to activity rather than spamming the inbox). Sorted
    /// reverse-chronologically; no urgency pin (urgent items live in inbox).
    private var activityItems: [FeedItem] {
        feedStore.items
            .filter { $0.status != .dismissed && $0.noteworthy != true }
            .sorted { $0.createdAt > $1.createdAt }
    }

    /// Dismissed items across both inbox and background tiers, most-recent
    /// first. Spans both tiers because once dismissed, the inbox/background
    /// distinction no longer matters to the user.
    private var dismissedItems: [FeedItem] {
        feedStore.items
            .filter { $0.status == .dismissed }
            .sorted { $0.createdAt > $1.createdAt }
    }

    /// Categories present in the inbox (non-dismissed, noteworthy). Drives
    /// the filter bar — only categories with at least one inbox item get a
    /// pill. The Background activity disclosure is unfiltered.
    private var presentCategories: Set<FeedItemCategory> {
        var cats = Set<FeedItemCategory>()
        for item in inboxItems {
            cats.insert(item.category ?? .system)
        }
        return cats
    }

    /// Sorts the inbox with urgent items pinned to the top, then by
    /// `priority desc, createdAt desc` within each urgency group, then
    /// buckets via `HomeFeedTimeGroup.bucket(_:)`. Dismissed and
    /// non-noteworthy items are excluded upstream by `inboxItems`.
    private var feedBuckets: [(group: HomeFeedTimeGroup, items: [FeedItem])] {
        let sorted = inboxItems.sorted { a, b in
            let aUrgent = isUrgent(a)
            let bUrgent = isUrgent(b)
            if aUrgent != bUrgent { return aUrgent }
            if a.priority != b.priority { return a.priority > b.priority }
            return a.createdAt > b.createdAt
        }
        let filtered: [FeedItem]
        if let active = activeFilter {
            filtered = sorted.filter { ($0.category ?? .system) == active }
        } else {
            filtered = sorted
        }
        return HomeFeedTimeGroup.bucket(filtered)
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

    /// Shared `HomeRecapRow` builder for the inbox, Background activity,
    /// and Dismissed sections. Urgent items only live in the inbox, so
    /// activity and dismissed rows pass `showsUrgency: false` to suppress
    /// the leading red dot.
    @ViewBuilder
    private func recapRow(
        for item: FeedItem,
        showsUrgency: Bool,
        trailingAction: HomeRecapRow.TrailingAction = .dismiss,
        onTrailing: (() -> Void)? = nil
    ) -> some View {
        // Fall back to `summary` when `title` is nil — the daemon omits
        // the title when no source title was supplied.
        HomeRecapRow(
            icon: icon(for: item),
            iconForeground: iconForeground(for: item),
            iconBackground: iconBackground(for: item),
            title: item.title ?? item.summary,
            timestamp: item.timestamp,
            status: item.status,
            isUrgent: showsUrgency && isUrgent(item),
            showsPersonaAvatar: item.fromAssistant == true,
            trailingAction: trailingAction,
            onDismiss: onTrailing ?? { dismissItem(item) },
            onTap: { openItem(item) }
        )
    }

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

    /// Restores to `.seen` rather than `.new` — re-promoting an item the
    /// user has already seen back to unread would be misleading.
    private func restoreItem(_ item: FeedItem) {
        Task {
            await feedStore.updateStatus(itemId: item.id, status: .seen)
        }
    }

    // MARK: - Skeleton

    /// Skeleton silhouette that mirrors the new three-block layout:
    /// a greeting row (avatar + New Chat CTA), the "have you tried…"
    /// suggestion bar (rounded 16pt pill bar, ~60pt tall), and a single
    /// "Today" group header with three 48pt recap bones. Designed so the
    /// first paint doesn't shift when real data lands.
    private var skeleton: some View {
        VStack(alignment: .leading, spacing: VSpacing.xxl) {
            HStack(spacing: VSpacing.md) {
                VSkeletonBone(width: 40, height: 40, radius: 20)
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

