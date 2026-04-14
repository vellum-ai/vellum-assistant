import SwiftUI
import VellumAssistantShared

/// Assembles the Home page: identity column on the left, and the facts +
/// capabilities columns on the right. This view is rendered inside
/// ``IntelligencePanel``'s existing `VPageContainer`, so it does NOT wrap
/// itself in another page container.
///
/// The parent owns all navigation decisions — the "Start a conversation"
/// and capability CTAs are plain closures plumbed through from the
/// ``PanelCoordinator``. PR 14 wires only `onStartConversation`; the
/// capability CTAs ship as no-op stubs that PR 15 replaces with seeded
/// new-chat handlers. Loading is driven by `store.load()` on appear; on
/// transport failure the store keeps the last-good state so we never
/// blank the UI between refreshes.
struct HomePageView: View {
    @Bindable var store: HomeStore
    @Bindable var feedStore: HomeFeedStore
    let onStartConversation: () -> Void
    let onPrimaryCTA: (Capability) -> Void
    let onShortcutCTA: (Capability) -> Void
    /// Fired when a feed action resolves to a daemon-created conversation
    /// — the receiver (usually `PanelCoordinator`) navigates into it.
    let onFeedConversationOpened: (String) -> Void

    /// Cap the two-column layout so the right column doesn't sprawl on a
    /// 32-inch display. Beyond ~960pt the line lengths stop being readable
    /// and the page starts to feel empty in the middle.
    private let maxContentWidth: CGFloat = 920

    /// `home-feed` is a macos-scope flag — same registry as `home-tab`.
    /// Resolved once at view creation; a runtime toggle requires a rebuild
    /// of the panel, which is acceptable for a v1 feature flag.
    private let isHomeFeedEnabled: Bool = MacOSClientFeatureFlagManager.shared.isEnabled("home-feed")

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
            if isHomeFeedEnabled {
                await feedStore.load()
            }
        }
    }

    private func content(for state: RelationshipState) -> some View {
        ScrollView {
            HStack(alignment: .top, spacing: VSpacing.xxl) {
                HomeIdentityPanel(
                    state: state,
                    onStartConversation: onStartConversation
                )
                .padding(.top, VSpacing.sm)

                VStack(alignment: .leading, spacing: VSpacing.xxl) {
                    HomeFactsSection(facts: state.facts)
                    if isHomeFeedEnabled {
                        HomeFeedSection(
                            store: feedStore,
                            onConversationOpened: onFeedConversationOpened
                        )
                    }
                    HomeCapabilitiesSection(
                        capabilities: state.capabilities,
                        onPrimaryCTA: onPrimaryCTA,
                        onShortcutCTA: onShortcutCTA
                    )
                }
                .frame(maxWidth: .infinity, alignment: .leading)
            }
            .frame(maxWidth: maxContentWidth, alignment: .topLeading)
            .padding(.horizontal, VSpacing.xl)
            .padding(.vertical, VSpacing.lg)
            .frame(maxWidth: .infinity, alignment: .top)
        }
    }

    private var skeleton: some View {
        HStack(alignment: .top, spacing: VSpacing.xxl) {
            VStack(alignment: .center, spacing: VSpacing.lg) {
                VSkeletonBone(width: 132, height: 132, radius: 66)
                VSkeletonBone(width: 120, height: 24)
                VSkeletonBone(width: 160, height: 14)
                VSkeletonBone(width: 110, height: 26, radius: VRadius.pill)
                VSkeletonBone(width: 140, height: 12)
                VSkeletonBone(width: 100, height: 12)
            }
            .frame(width: 220, alignment: .center)
            .padding(.top, VSpacing.sm)

            VStack(alignment: .leading, spacing: VSpacing.xxl) {
                VStack(alignment: .leading, spacing: VSpacing.md) {
                    VSkeletonBone(width: 220, height: 22)
                    VSkeletonBone(width: 320, height: 14)
                    VSkeletonBone(width: 280, height: 14)
                }
                VStack(alignment: .leading, spacing: VSpacing.md) {
                    VSkeletonBone(width: 180, height: 22)
                    VSkeletonBone(height: 52, radius: VRadius.lg)
                    VSkeletonBone(height: 52, radius: VRadius.lg)
                    VSkeletonBone(height: 52, radius: VRadius.lg)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .frame(maxWidth: maxContentWidth, alignment: .topLeading)
        .padding(.horizontal, VSpacing.xl)
        .padding(.vertical, VSpacing.lg)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
    }
}
