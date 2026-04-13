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
    let onStartConversation: () -> Void
    let onPrimaryCTA: (Capability) -> Void
    let onShortcutCTA: (Capability) -> Void

    var body: some View {
        Group {
            if let state = store.state {
                HStack(alignment: .top, spacing: VSpacing.xl) {
                    HomeIdentityPanel(
                        state: state,
                        onStartConversation: onStartConversation
                    )
                    ScrollView {
                        VStack(alignment: .leading, spacing: VSpacing.xl) {
                            HomeFactsSection(facts: state.facts)
                            HomeCapabilitiesSection(
                                capabilities: state.capabilities,
                                onPrimaryCTA: onPrimaryCTA,
                                onShortcutCTA: onShortcutCTA
                            )
                        }
                        .frame(maxWidth: .infinity, alignment: .leading)
                    }
                }
                .padding(VSpacing.lg)
                .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
                .background(VColor.surfaceBase)
            } else {
                skeleton
            }
        }
        .task {
            await store.load()
        }
    }

    private var skeleton: some View {
        HStack(alignment: .top, spacing: VSpacing.xl) {
            VStack(alignment: .leading, spacing: VSpacing.lg) {
                VSkeletonBone(width: 140, height: 140, radius: 70)
                VSkeletonBone(width: 160, height: 24)
                VSkeletonBone(width: 120, height: 14)
                VSkeletonBone(width: 100, height: 24, radius: VRadius.lg)
                VSkeletonBone(width: 180, height: 12)
                VSkeletonBone(width: 140, height: 12)
            }
            .frame(width: 220, alignment: .leading)

            VStack(alignment: .leading, spacing: VSpacing.xl) {
                VStack(alignment: .leading, spacing: VSpacing.sm) {
                    VSkeletonBone(width: 200, height: 18)
                    VSkeletonBone(width: 320, height: 14)
                    VSkeletonBone(width: 280, height: 14)
                }
                VStack(alignment: .leading, spacing: VSpacing.sm) {
                    VSkeletonBone(width: 200, height: 18)
                    VSkeletonBone(height: 56, radius: VRadius.lg)
                    VSkeletonBone(height: 56, radius: VRadius.lg)
                    VSkeletonBone(height: 56, radius: VRadius.lg)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .padding(VSpacing.lg)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .background(VColor.surfaceBase)
    }
}
