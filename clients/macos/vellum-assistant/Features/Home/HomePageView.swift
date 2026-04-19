import SwiftUI
import VellumAssistantShared

/// Assembles the Home page: a centered editorial column with a hero
/// greeting, an inline chat input, and three prioritized sections —
/// attention, capabilities, activity.
///
/// This view is rendered inside the Home panel's `VPageContainer` in
/// ``PanelCoordinator``, so it does NOT wrap itself in another page
/// container.
///
/// The parent owns all navigation decisions — every CTA is a plain
/// closure plumbed through from the ``PanelCoordinator``. Loading is
/// driven by `store.load()` / `feedStore.load()` on appear; on transport
/// failure both stores keep the last-good state so we never blank the UI
/// between refreshes.
struct HomePageView: View {
    @Bindable var store: HomeStore
    @Bindable var feedStore: HomeFeedStore
    /// Drives the "In meeting" status panel rendered at the top of the
    /// gallery. Owned by the parent so the panel survives panel-dismiss
    /// cycles and keeps its SSE subscription live for the whole session.
    @Bindable var meetStatusViewModel: MeetStatusViewModel
    let onPrimaryCTA: (Capability) -> Void
    let onShortcutCTA: (Capability) -> Void
    /// Fired when a feed action resolves to a daemon-created conversation
    /// — the receiver (usually `PanelCoordinator`) navigates into it.
    let onFeedConversationOpened: (String) -> Void
    /// Fired when the user submits text through the inline composer. The
    /// parent opens a fresh conversation pre-seeded with the message and
    /// navigates into it.
    let onSubmitMessage: (String) -> Void

    /// Editorial column width. Narrower than the previous two-column
    /// layout (920pt) on purpose — the redesigned Home reads as a single
    /// focused stream, not a dashboard.
    private let maxContentWidth: CGFloat = 600

    var body: some View {
        Group {
            if let state = store.state {
                content(for: state)
            } else {
                skeleton
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
        .background(VColor.surfaceBase)
        .task {
            await store.load()
            await feedStore.load()
        }
    }

    // MARK: - Content

    private func content(for state: RelationshipState) -> some View {
        ScrollView {
            VStack(alignment: .center, spacing: VSpacing.xxl) {
                // "In meeting" status banner — returns EmptyView when idle,
                // so when no meeting is active the layout collapses to the
                // prior hero-first appearance.
                MeetStatusPanel(viewModel: meetStatusViewModel)

                HomeHeroView(state: state)
                    .padding(.top, VSpacing.xxl)

                HomeInlineComposer(onSubmit: onSubmitMessage)

                if !attentionItems.isEmpty {
                    section(title: "These need your attention") {
                        ForEach(attentionItems, id: \.id) { item in
                            HomeListRow {
                                HomeActivityRow(
                                    item: item,
                                    onTap: { openItem(item) },
                                    onComplete: item.status != .actedOn
                                        ? { Task { await feedStore.dismiss(itemId: item.id) } }
                                        : nil
                                )
                            }
                        }
                    }
                }

                if !state.capabilities.isEmpty {
                    section(title: "Here's what I can do for you") {
                        HomeCapabilitiesSection(
                            capabilities: state.capabilities,
                            onPrimaryCTA: onPrimaryCTA,
                            onShortcutCTA: onShortcutCTA
                        )
                    }
                }

                if !activityItems.isEmpty {
                    section(title: "Here's what I've been up to") {
                        ForEach(activityItems, id: \.id) { item in
                            HomeListRow {
                                HomeActivityRow(
                                    item: item,
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

    // MARK: - Section wrapper

    /// A centered title label followed by its content. The label uses
    /// `bodySmallDefault` on `contentSecondary` to read as a quiet
    /// editorial lede rather than a heavy header.
    @ViewBuilder
    private func section<Content: View>(
        title: String,
        @ViewBuilder content: () -> Content
    ) -> some View {
        VStack(alignment: .leading, spacing: VSpacing.md) {
            Text(title)
                .font(VFont.bodySmallDefault)
                .foregroundStyle(VColor.contentSecondary)
                .frame(maxWidth: .infinity, alignment: .center)
                .accessibilityAddTraits(.isHeader)

            VStack(alignment: .leading, spacing: VSpacing.sm) {
                content()
            }
        }
    }

    // MARK: - Feed partitioning

    /// Items that belong in "These need your attention" — nudges the
    /// assistant is surfacing and actions it's suggesting. Priority
    /// desc, then newest within ties.
    private var attentionItems: [FeedItem] {
        feedStore.items
            .filter { $0.type == .nudge || $0.type == .action }
            .sorted { a, b in
                if a.priority != b.priority { return a.priority > b.priority }
                return a.createdAt > b.createdAt
            }
    }

    /// Items that belong in "Here's what I've been up to" — passive
    /// digests of work the assistant did, and threads it started or
    /// participated in.
    private var activityItems: [FeedItem] {
        feedStore.items
            .filter { $0.type == .digest || $0.type == .thread }
            .sorted { a, b in
                if a.priority != b.priority { return a.priority > b.priority }
                return a.createdAt > b.createdAt
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

    private var skeleton: some View {
        VStack(alignment: .center, spacing: VSpacing.xxl) {
            HStack(spacing: VSpacing.md) {
                VSkeletonBone(width: 44, height: 44, radius: 22)
                VSkeletonBone(width: 280, height: 28)
            }
            .padding(.top, VSpacing.xxl)

            VSkeletonBone(height: 52, radius: VRadius.window)

            VStack(alignment: .leading, spacing: VSpacing.sm) {
                VSkeletonBone(width: 180, height: 12)
                    .frame(maxWidth: .infinity, alignment: .center)
                VSkeletonBone(height: 64, radius: VRadius.window)
                VSkeletonBone(height: 64, radius: VRadius.window)
                VSkeletonBone(height: 64, radius: VRadius.window)
            }
        }
        .frame(maxWidth: maxContentWidth, alignment: .top)
        .padding(.horizontal, VSpacing.xl)
        .padding(.bottom, VSpacing.xxl)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
    }
}
