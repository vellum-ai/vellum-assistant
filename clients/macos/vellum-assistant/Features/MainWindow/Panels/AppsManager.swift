import SwiftUI

enum AppFilter: String, CaseIterable {
    case all = "All"
    case favorites = "Favorites"
    case recent = "Recent"
}

@MainActor
final class AppsManager: ObservableObject {
    @Published var apps: [AppSummaryItem] = []
    @Published var isLoading = false

    private let daemonClient: DaemonClient

    private static let favoritesKey = "favoriteAppIds"
    private static let recentKey = "recentAppIds"
    private static let maxRecent = 10

    var favoriteIds: Set<String> {
        get {
            Set(UserDefaults.standard.stringArray(forKey: Self.favoritesKey) ?? [])
        }
        set {
            UserDefaults.standard.set(Array(newValue), forKey: Self.favoritesKey)
            objectWillChange.send()
        }
    }

    var recentIds: [String] {
        get {
            UserDefaults.standard.stringArray(forKey: Self.recentKey) ?? []
        }
        set {
            UserDefaults.standard.set(newValue, forKey: Self.recentKey)
            objectWillChange.send()
        }
    }

    var favoriteApps: [AppSummaryItem] {
        let ids = favoriteIds
        return apps.filter { ids.contains($0.id) }
    }

    var recentApps: [AppSummaryItem] {
        let ordered = recentIds
        return ordered.compactMap { id in apps.first { $0.id == id } }
    }

    init(daemonClient: DaemonClient) {
        self.daemonClient = daemonClient
    }

    func fetchApps() {
        guard !isLoading else { return }
        isLoading = true

        Task {
            let stream = daemonClient.subscribe()

            do {
                try daemonClient.requestAppsList()
            } catch {
                isLoading = false
                return
            }

            for await message in stream {
                if case .appsListResponse(let response) = message {
                    apps = response.apps
                    isLoading = false
                    return
                }
            }
            isLoading = false
        }
    }

    func toggleFavorite(_ appId: String) {
        var ids = favoriteIds
        if ids.contains(appId) {
            ids.remove(appId)
        } else {
            ids.insert(appId)
        }
        favoriteIds = ids
    }

    func markRecent(_ appId: String) {
        var ids = recentIds
        ids.removeAll { $0 == appId }
        ids.insert(appId, at: 0)
        if ids.count > Self.maxRecent {
            ids = Array(ids.prefix(Self.maxRecent))
        }
        recentIds = ids
    }

    func filteredApps(searchText: String, filter: AppFilter) -> [AppSummaryItem] {
        let base: [AppSummaryItem]
        switch filter {
        case .all:
            base = apps
        case .favorites:
            base = favoriteApps
        case .recent:
            base = recentApps
        }

        if searchText.isEmpty {
            return base
        }

        let query = searchText.lowercased()
        return base.filter {
            $0.name.lowercased().contains(query) ||
            ($0.description?.lowercased().contains(query) ?? false)
        }
    }
}
