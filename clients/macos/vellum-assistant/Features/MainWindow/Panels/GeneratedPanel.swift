import SwiftUI

struct GeneratedPanel: View {
    var onClose: () -> Void
    @ObservedObject var appsManager: AppsManager

    @State private var searchText = ""
    @State private var selectedFilter: AppFilter = .all

    private let columns = [GridItem(.adaptive(minimum: 180), spacing: VSpacing.sm)]

    var body: some View {
        VSidePanel(title: "Generated", onClose: onClose) {
            VStack(alignment: .leading, spacing: VSpacing.lg) {
                VTextField(placeholder: "Search apps...", text: $searchText, leadingIcon: "magnifyingglass")

                filterTabs

                let filtered = appsManager.filteredApps(searchText: searchText, filter: selectedFilter)

                if appsManager.apps.isEmpty && !appsManager.isLoading {
                    VEmptyState(
                        title: "No generated apps",
                        subtitle: "Apps created by your assistant will appear here",
                        icon: "wand.and.stars"
                    )
                } else if filtered.isEmpty {
                    VEmptyState(
                        title: "No results",
                        subtitle: "Try a different search or filter"
                    )
                } else {
                    LazyVGrid(columns: columns, spacing: VSpacing.sm) {
                        ForEach(filtered) { app in
                            VAppPill(
                                name: app.name,
                                icon: app.icon,
                                isFavorite: appsManager.favoriteIds.contains(app.id),
                                onTap: {
                                    appsManager.markRecent(app.id)
                                },
                                onToggleFavorite: {
                                    appsManager.toggleFavorite(app.id)
                                }
                            )
                        }
                    }
                }
            }
        }
        .onAppear {
            appsManager.fetchApps()
        }
    }

    private var filterTabs: some View {
        HStack(spacing: VSpacing.xs) {
            ForEach(AppFilter.allCases, id: \.self) { filter in
                Button(action: { selectedFilter = filter }) {
                    Text(filter.rawValue)
                        .font(VFont.captionMedium)
                        .foregroundColor(selectedFilter == filter ? VColor.textPrimary : VColor.textMuted)
                        .padding(.horizontal, VSpacing.md)
                        .padding(.vertical, VSpacing.xs)
                        .background(selectedFilter == filter ? VColor.surface : .clear)
                        .clipShape(RoundedRectangle(cornerRadius: VRadius.pill))
                }
                .buttonStyle(.plain)
            }
        }
    }
}

#Preview {
    GeneratedPanel(onClose: {}, appsManager: AppsManager(daemonClient: DaemonClient()))
}
