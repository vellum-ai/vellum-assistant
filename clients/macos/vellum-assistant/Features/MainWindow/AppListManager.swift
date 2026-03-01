import Foundation
import os
import VellumAssistantShared

private let log = Logger(subsystem: Bundle.main.bundleIdentifier ?? "com.vellum.vellum-assistant", category: "AppListManager")

@MainActor
final class AppListManager: ObservableObject {

    struct AppItem: Identifiable, Codable, Hashable {
        let id: String
        var name: String
        var description: String? = nil
        var icon: String?
        var previewBase64: String?
        var appType: String?
        var lastOpenedAt: Date
        var isPinned: Bool = false
        var pinnedOrder: Int? = nil
        /// SF Symbol name for the generated app icon (e.g., "chart.line.uptrend.xyaxis")
        var sfSymbol: String? = nil
        /// Pair of hex color strings for the gradient background (e.g., ["#7C3AED", "#4F46E5"])
        var iconBackground: [String]? = nil
    }

    @Published var apps: [AppItem] = []

    /// IDs of apps the user explicitly removed. Prevents daemon sync from re-adding them.
    private var removedAppIds: Set<String> = []

    private let fileURL: URL

    /// Only pinned apps, sorted by pinnedOrder ascending.
    var pinnedApps: [AppItem] {
        apps.filter(\.isPinned)
            .sorted { ($0.pinnedOrder ?? 0) < ($1.pinnedOrder ?? 0) }
    }

    /// Apps sorted for display: pinned first (by pinnedOrder ascending), then unpinned by lastOpenedAt descending.
    var displayApps: [AppItem] {
        apps.sorted { a, b in
            if a.isPinned && b.isPinned {
                return (a.pinnedOrder ?? 0) < (b.pinnedOrder ?? 0)
            }
            if a.isPinned { return true }
            if b.isPinned { return false }
            return a.lastOpenedAt > b.lastOpenedAt
        }
    }

    init() {
        let fileManager = FileManager.default
        let appSupport = fileManager.urls(for: .applicationSupportDirectory, in: .userDomainMask).first!
        let dir = appSupport.appendingPathComponent("vellum-assistant", isDirectory: true)
        try? fileManager.createDirectory(at: dir, withIntermediateDirectories: true)
        self.fileURL = dir.appendingPathComponent("app-list.json")
        load()
    }

    func recordAppOpen(id: String, name: String, icon: String? = nil, previewBase64: String? = nil, appType: String? = nil, description: String? = nil) {
        // Clear tombstone so an explicitly re-opened app reappears in the sidebar
        removedAppIds.remove(id)

        if let index = apps.firstIndex(where: { $0.id == id }) {
            // Don't reshuffle apps that are already visible in the collapsed top-5 sidebar.
            let top5Ids = Set(displayApps.prefix(5).map(\.id))
            if !top5Ids.contains(id) {
                apps[index].lastOpenedAt = Date()
            }
            apps[index].name = name
            if let icon { apps[index].icon = icon }
            if let previewBase64 { apps[index].previewBase64 = previewBase64 }
            if let appType { apps[index].appType = appType }
            if let description { apps[index].description = description }
            // Auto-assign icon if this app doesn't have one yet
            if apps[index].sfSymbol == nil {
                let generated = VAppIconGenerator.generate(from: name, type: appType ?? apps[index].appType)
                apps[index].sfSymbol = generated.sfSymbol
                apps[index].iconBackground = generated.colors
            }
        } else {
            let generated = VAppIconGenerator.generate(from: name, type: appType)
            var item = AppItem(
                id: id,
                name: name,
                description: description,
                icon: icon,
                previewBase64: previewBase64,
                appType: appType,
                lastOpenedAt: Date()
            )
            item.sfSymbol = generated.sfSymbol
            item.iconBackground = generated.colors
            apps.append(item)
        }
        save()
    }

    func pinApp(id: String) {
        guard let index = apps.firstIndex(where: { $0.id == id }), !apps[index].isPinned else { return }
        let nextOrder = (apps.compactMap(\.pinnedOrder).max() ?? -1) + 1
        apps[index].isPinned = true
        apps[index].pinnedOrder = nextOrder
        save()
    }

    func unpinApp(id: String) {
        guard let index = apps.firstIndex(where: { $0.id == id }) else { return }
        apps[index].isPinned = false
        apps[index].pinnedOrder = nil
        recompactPinnedOrders()
        save()
    }

    func reorderPinnedApps(from source: IndexSet, to destination: Int) {
        var pinned = displayApps.filter(\.isPinned)
        pinned.move(fromOffsets: source, toOffset: destination)
        for (order, item) in pinned.enumerated() {
            if let idx = apps.firstIndex(where: { $0.id == item.id }) {
                apps[idx].pinnedOrder = order
            }
        }
        save()
    }

    /// Sync apps from the daemon's authoritative list into the local sidebar list.
    /// Adds any apps that don't already exist locally, using their daemon createdAt timestamp.
    /// Always propagates daemon descriptions to existing apps when they differ.
    func syncFromDaemon(_ daemonApps: [AppItem_Daemon]) {
        let existingIds = Set(apps.map(\.id))
        var newCount = 0
        var updatedCount = 0
        for daemonApp in daemonApps {
            if existingIds.contains(daemonApp.id) {
                if let desc = daemonApp.description,
                   let index = apps.firstIndex(where: { $0.id == daemonApp.id }),
                   apps[index].description != desc {
                    apps[index].description = desc
                    updatedCount += 1
                }
                continue
            }
            guard !removedAppIds.contains(daemonApp.id) else { continue }
            let generated = VAppIconGenerator.generate(from: daemonApp.name, type: daemonApp.appType)
            var item = AppItem(
                id: daemonApp.id,
                name: daemonApp.name,
                description: daemonApp.description,
                icon: daemonApp.icon,
                appType: daemonApp.appType,
                lastOpenedAt: Date(timeIntervalSince1970: TimeInterval(daemonApp.createdAt) / 1000.0)
            )
            item.sfSymbol = generated.sfSymbol
            item.iconBackground = generated.colors
            apps.append(item)
            newCount += 1
        }
        if newCount > 0 || updatedCount > 0 {
            save()
            log.info("Synced from daemon: \(newCount) new app(s), \(updatedCount) description(s) updated")
        }
    }

    /// Lightweight wrapper for the daemon's app representation, used by syncFromDaemon.
    struct AppItem_Daemon {
        let id: String
        let name: String
        let description: String?
        let icon: String?
        let appType: String?
        let createdAt: Int
    }

    func removeApp(id: String) {
        apps.removeAll { $0.id == id }
        removedAppIds.insert(id)
        save()
    }

    func updateAppIcon(id: String, sfSymbol: String, iconBackground: [String]) {
        guard let index = apps.firstIndex(where: { $0.id == id }) else { return }
        apps[index].sfSymbol = sfSymbol
        apps[index].iconBackground = iconBackground
        save()
    }

    /// Move an app to a new position (for drag-and-drop reorder).
    /// Returns `true` if the reorder was actually performed.
    @discardableResult
    func moveApp(sourceId: String, beforeId: String) -> Bool {
        guard let sourceIdx = apps.firstIndex(where: { $0.id == sourceId }),
              let targetIdx = apps.firstIndex(where: { $0.id == beforeId }) else { return false }
        let targetApp = apps[targetIdx]

        // Only reorder when the drop target is pinned
        guard targetApp.isPinned else { return false }

        if !apps[sourceIdx].isPinned {
            apps[sourceIdx].isPinned = true
        }
        let targetOrder = targetApp.pinnedOrder ?? 0
        apps[sourceIdx].pinnedOrder = targetOrder
        for i in apps.indices where apps[i].isPinned && apps[i].id != sourceId {
            if let order = apps[i].pinnedOrder, order >= targetOrder {
                apps[i].pinnedOrder = order + 1
            }
        }
        recompactPinnedOrders()
        save()
        return true
    }

    // MARK: - Persistence

    /// On-disk container wrapping both the app list and the removal tombstone set.
    private struct PersistedData: Codable {
        var apps: [AppItem]
        var removedAppIds: Set<String>?
    }

    private func save() {
        do {
            let encoder = JSONEncoder()
            encoder.dateEncodingStrategy = .iso8601
            encoder.outputFormatting = .prettyPrinted
            let container = PersistedData(apps: apps, removedAppIds: removedAppIds)
            let data = try encoder.encode(container)
            try data.write(to: fileURL, options: .atomic)
        } catch {
            log.error("Failed to save app list: \(error.localizedDescription)")
        }
    }

    private func load() {
        guard let data = try? Data(contentsOf: fileURL) else { return }
        do {
            let decoder = JSONDecoder()
            decoder.dateDecodingStrategy = .iso8601

            // Try the new container format first, fall back to the legacy bare-array format
            if let container = try? decoder.decode(PersistedData.self, from: data) {
                apps = container.apps
                removedAppIds = container.removedAppIds ?? []
            } else {
                apps = try decoder.decode([AppItem].self, from: data)
                removedAppIds = []
            }
            log.info("Loaded \(self.apps.count) app list entries")

            // Migrate existing apps that don't have icons assigned yet
            var didMigrate = false
            for index in apps.indices where apps[index].sfSymbol == nil {
                let generated = VAppIconGenerator.generate(from: apps[index].name, type: apps[index].appType)
                apps[index].sfSymbol = generated.sfSymbol
                apps[index].iconBackground = generated.colors
                didMigrate = true
            }
            if didMigrate {
                save()
                log.info("Migrated app icons for existing entries")
            }
        } catch {
            log.error("Failed to load app list: \(error.localizedDescription)")
        }
    }

    private func recompactPinnedOrders() {
        let pinned = apps.enumerated()
            .filter { $0.element.isPinned }
            .sorted { ($0.element.pinnedOrder ?? 0) < ($1.element.pinnedOrder ?? 0) }
        for (order, item) in pinned.enumerated() {
            apps[item.offset].pinnedOrder = order
        }
    }
}
