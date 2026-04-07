import SwiftUI
import VellumAssistantShared

/// Main Home panel composing the context banner, nudge cards,
/// sectioned lists, and the empty state.
struct HomeView: View {
    let store: HomeFeedStore
    let onClose: () -> Void

    var body: some View {
        let filtered = filteredItems
        let nudges = filtered.filter { $0.type == .nudge && $0.status != .actedOn }
        let digests = filtered.filter { $0.type == .digest }
        let actions = filtered.filter { $0.type == .action }
        let threads = filtered.filter { $0.type == .thread }
        let allEmpty = nudges.isEmpty && digests.isEmpty && actions.isEmpty && threads.isEmpty

        VStack(spacing: 0) {
            // Close button
            HStack {
                Spacer()
                VButton(label: "Close", iconOnly: VIcon.x.rawValue, style: .ghost, action: onClose)
            }
            .padding(EdgeInsets(top: VSpacing.md, leading: VSpacing.lg, bottom: 0, trailing: VSpacing.lg))

            if allEmpty && !store.isLoading {
                HomeEmptyState()
            } else {
                ScrollView(.vertical, showsIndicators: false) {
                    VStack(alignment: .leading, spacing: VSpacing.xl) {
                        HomeContextBanner(
                            lastSessionDate: store.lastUpdated,
                            newCount: store.newCount
                        )

                        // NEEDS ATTENTION: nudges as full cards, no cap
                        if !nudges.isEmpty {
                            VStack(alignment: .leading, spacing: VSpacing.sm) {
                                Text("NEEDS ATTENTION")
                                    .font(VFont.bodySmallEmphasised)
                                    .foregroundStyle(VColor.contentTertiary)
                                    .padding(.leading, VSpacing.lg)
                                    .accessibilityAddTraits(.isHeader)

                                ForEach(nudges) { item in
                                    HomeNudgeCard(
                                        item: item,
                                        onDismiss: { Task { await store.dismiss(item.id) } },
                                        onAction: { actionId in Task { await store.triggerAction(itemId: item.id, actionId: actionId) } }
                                    )
                                    .padding(.horizontal, VSpacing.lg)
                                }
                            }
                        }

                        // CATCH UP: digests as compact rows, cap 5
                        if !digests.isEmpty {
                            HomeSectionView(title: "CATCH UP", items: digests, cap: 5)
                                .padding(.horizontal, VSpacing.lg)
                        }

                        // DONE SINCE LAST SESSION: actions as compact rows, cap 3
                        if !actions.isEmpty {
                            HomeSectionView(title: "DONE SINCE LAST SESSION", items: actions, cap: 3)
                                .padding(.horizontal, VSpacing.lg)
                        }

                        // ACTIVE THREADS: threads as compact rows, cap 4
                        if !threads.isEmpty {
                            HomeSectionView(title: "ACTIVE THREADS", items: threads, cap: 4)
                                .padding(.horizontal, VSpacing.lg)
                        }
                    }
                    .padding(.bottom, VSpacing.xl)
                }
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(VColor.surfaceBase)
        .task {
            await store.fetch()
        }
    }

    // MARK: - Client-Side minTimeAway Filtering

    /// Filters items based on the `minTimeAway` threshold.
    /// Items whose `minTimeAway` exceeds the time since last session are hidden.
    private var filteredItems: [FeedItem] {
        guard let lastSession = store.lastUpdated else { return store.items }
        let timeAway = Date().timeIntervalSince(lastSession)
        return store.items.filter { item in
            guard let minTimeAway = item.minTimeAway else { return true }
            return timeAway >= minTimeAway
        }
    }
}
