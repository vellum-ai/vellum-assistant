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

                ForEach(Array(groupedFeed.enumerated()), id: \.element.group) { _, bucket in
                    VStack(alignment: .leading, spacing: VSpacing.md) {
                        HomeFeedGroupHeader(label: bucket.group.label)
                        VStack(alignment: .leading, spacing: VSpacing.xs) {
                            ForEach(bucket.items, id: \.id) { item in
                                HomeRecapRow(
                                    icon: icon(for: item),
                                    iconForeground: iconForeground(for: item),
                                    iconBackground: iconBackground(for: item),
                                    title: item.title,
                                    actionLabel: actionLabel(for: item),
                                    onAction: actionLabel(for: item) == nil ? nil : { openItem(item) },
                                    onTap: { openItem(item) }
                                )
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

    /// Sorts the feed by `priority desc, createdAt desc`, then delegates
    /// to `HomeFeedTimeGroup.bucket(_:)` for day-bucketing. Replaces the
    /// prior `attentionItems` / `activityItems` partitioning.
    private var groupedFeed: [(group: HomeFeedTimeGroup, items: [FeedItem])] {
        let sorted = feedStore.items.sorted { a, b in
            if a.priority != b.priority { return a.priority > b.priority }
            return a.createdAt > b.createdAt
        }
        return HomeFeedTimeGroup.bucket(sorted)
    }

    // MARK: - Suggestions

    /// Stopgap source of suggestion pills: the first three capabilities
    /// the daemon surfaced for this relationship. The long-term source is
    /// a dedicated `HomeFeedResponse.suggestions` field on the feed
    /// payload.
    /// TODO: swap to `HomeFeedResponse.suggestions` once the daemon
    /// contract lands (tracked by the Home redesign plan).
    private var currentSuggestions: [HomeSuggestion] {
        guard let capabilities = store.state?.capabilities else { return [] }
        return capabilities.prefix(3).map { capability in
            HomeSuggestion(
                id: capability.id,
                icon: capabilityIcon(capability),
                label: capability.name
            )
        }
    }

    /// Picks an icon for a capability suggestion pill. We don't have a
    /// per-capability icon field, so fall back to a small rotating set of
    /// generic "action" glyphs. Safe default is `.sparkles` — matches the
    /// suggestion bar preview.
    private func capabilityIcon(_ capability: Capability) -> VIcon {
        switch capability.tier {
        case .unlocked: return .sparkles
        case .nextUp:   return .wand
        case .earned:   return .star
        }
    }

    // MARK: - Recap row styling

    /// Icon glyph for a feed item, driven by type + source. Mapping
    /// follows the Figma spec:
    ///   nudge + assistant   → heart
    ///   action              → arrow-left (inbound intent)
    ///   digest              → bell
    ///   thread              → message-circle
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
            return .messageCircle
        }
    }

    /// Foreground (glyph) color for the recap icon. The plan referenced
    /// raw Danger/Forest 500-scale colors, which do not exist in this
    /// codebase — the closest semantic tokens live in `VColor` (see
    /// `ColorTokens.swift`). No raw hex values are used.
    private func iconForeground(for item: FeedItem) -> Color {
        switch item.type {
        case .nudge:
            // Plan: Danger._500. Closest existing token.
            return VColor.systemNegativeStrong
        case .action:
            return VColor.primaryBase
        case .digest:
            // Plan: Forest._500. Closest existing token.
            return VColor.systemPositiveStrong
        case .thread:
            return VColor.contentSecondary
        }
    }

    /// Background (circle fill) color for the recap icon.
    private func iconBackground(for item: FeedItem) -> Color {
        switch item.type {
        case .nudge:
            // Plan: Danger._900. Closest existing weak-negative tint.
            return VColor.systemNegativeWeak
        case .action:
            // Plan called for "a muted surface" paired with a blue/primary
            // tint. `surfaceActive` is the muted surface token; the glyph
            // picks up `primaryBase` for the blue/primary accent.
            return VColor.surfaceActive
        case .digest:
            // Plan: Forest._900. Closest existing weak-positive tint.
            return VColor.systemPositiveWeak
        case .thread:
            return VColor.surfaceActive
        }
    }

    /// Trailing Action button label for a recap row, or nil to hide the
    /// button entirely. Nudges are tap-to-open (no button); actions
    /// always show a button; digests show a button only if the daemon
    /// attached explicit actions; threads are tap-to-open.
    private func actionLabel(for item: FeedItem) -> String? {
        switch item.type {
        case .nudge:
            return nil
        case .action:
            return "Action"
        case .digest:
            return (item.actions?.isEmpty == false) ? "Action" : nil
        case .thread:
            return nil
        }
    }

    // MARK: - Actions

    /// Opens the feed item in a new conversation. The daemon interprets
    /// any unknown action id as an "open" intent and seeds the new
    /// conversation with the first available action's prompt (or the
    /// item summary if there are no actions).
    private func openItem(_ item: FeedItem) {
        Task {
            if let conversationId = await feedStore.triggerAction(
                itemId: item.id,
                actionId: "open"
            ) {
                onFeedConversationOpened(conversationId)
            }
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
        onSuggestionSelected: @escaping (HomeSuggestion) -> Void
    ) {
        self.init(
            store: store,
            feedStore: feedStore,
            meetStatusViewModel: meetStatusViewModel,
            onFeedConversationOpened: onFeedConversationOpened,
            onStartNewChat: onStartNewChat,
            onDismissSuggestions: onDismissSuggestions,
            onSuggestionSelected: onSuggestionSelected,
            isDetailPanelVisible: false,
            detailPanel: { EmptyView() }
        )
    }
}
