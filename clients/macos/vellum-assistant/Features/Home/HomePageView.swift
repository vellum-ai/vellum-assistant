import SwiftUI
import VellumAssistantShared

/// Assembles the Home page: identity column on the left, and the facts +
/// capabilities columns on the right. This view is rendered inside
/// ``IntelligencePanel``'s existing `VPageContainer`, so it does NOT wrap
/// itself in another page container.
///
/// The parent owns all navigation decisions — the "Start a conversation"
/// and capability CTAs are plain closures plumbed through from the
/// ``PanelCoordinator``. Loading is driven by `store.load()` on appear; on
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
                ProgressView()
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                    .background(VColor.surfaceBase)
            }
        }
        .task {
            await store.load()
        }
    }
}
