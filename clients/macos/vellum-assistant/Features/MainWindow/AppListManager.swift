import Foundation
import os
import VellumAssistantShared

private let log = Logger(subsystem: Bundle.appBundleIdentifier, category: "AppListManager")

@MainActor
@Observable
final class AppListManager {

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
        /// Lucide icon raw value for the generated app icon (e.g., "lucide-globe")
        var lucideIcon: String? = nil

        private enum CodingKeys: String, CodingKey {
            case id, name, description, icon, previewBase64, appType, lastOpenedAt, isPinned, pinnedOrder
            case lucideIcon
            // Legacy key for backwards compatibility
            case sfSymbol
        }

        init(
            id: String,
            name: String,
            description: String? = nil,
            icon: String? = nil,
            previewBase64: String? = nil,
            appType: String? = nil,
            lastOpenedAt: Date,
            isPinned: Bool = false,
            pinnedOrder: Int? = nil,
            lucideIcon: String? = nil
        ) {
            self.id = id
            self.name = name
            self.description = description
            self.icon = icon
            self.previewBase64 = previewBase64
            self.appType = appType
            self.lastOpenedAt = lastOpenedAt
            self.isPinned = isPinned
            self.pinnedOrder = pinnedOrder
            self.lucideIcon = lucideIcon
        }

        init(from decoder: Decoder) throws {
            let container = try decoder.container(keyedBy: CodingKeys.self)
            id = try container.decode(String.self, forKey: .id)
            name = try container.decode(String.self, forKey: .name)
            description = try container.decodeIfPresent(String.self, forKey: .description)
            icon = try container.decodeIfPresent(String.self, forKey: .icon)
            previewBase64 = try container.decodeIfPresent(String.self, forKey: .previewBase64)
            appType = try container.decodeIfPresent(String.self, forKey: .appType)
            lastOpenedAt = try container.decode(Date.self, forKey: .lastOpenedAt)
            isPinned = try container.decodeIfPresent(Bool.self, forKey: .isPinned) ?? false
            pinnedOrder = try container.decodeIfPresent(Int.self, forKey: .pinnedOrder)

            // Read new key first, fall back to legacy sfSymbol key
            if let lucide = try container.decodeIfPresent(String.self, forKey: .lucideIcon) {
                lucideIcon = lucide
            } else if let legacy = try container.decodeIfPresent(String.self, forKey: .sfSymbol) {
                // Migrate SF Symbol name → VIcon raw value
                lucideIcon = SFSymbolMapping.icon(forSFSymbol: legacy)?.rawValue
            } else {
                lucideIcon = nil
            }
        }

        func encode(to encoder: Encoder) throws {
            var container = encoder.container(keyedBy: CodingKeys.self)
            try container.encode(id, forKey: .id)
            try container.encode(name, forKey: .name)
            try container.encodeIfPresent(description, forKey: .description)
            try container.encodeIfPresent(icon, forKey: .icon)
            try container.encodeIfPresent(previewBase64, forKey: .previewBase64)
            try container.encodeIfPresent(appType, forKey: .appType)
            try container.encode(lastOpenedAt, forKey: .lastOpenedAt)
            try container.encode(isPinned, forKey: .isPinned)
            try container.encodeIfPresent(pinnedOrder, forKey: .pinnedOrder)
            try container.encodeIfPresent(lucideIcon, forKey: .lucideIcon)
        }
    }

    var apps: [AppItem] = []

    /// Only pinned apps, sorted by pinnedOrder ascending.
    /// Stored (not computed) so SwiftUI body evaluation is O(1) and views track
    /// this property directly instead of the broader `apps` array.
    private(set) var pinnedApps: [AppItem] = []

    /// Apps sorted for display: pinned first (by pinnedOrder ascending), then unpinned by lastOpenedAt descending.
    /// Stored for the same reason as `pinnedApps`.
    private(set) var displayApps: [AppItem] = []

    /// IDs of apps the user explicitly removed. Prevents daemon sync from re-adding them.
    @ObservationIgnored private var removedAppIds: Set<String> = []

    @ObservationIgnored private let fileURL: URL

    init() {
        let fileManager = FileManager.default
        let appSupport = fileManager.urls(for: .applicationSupportDirectory, in: .userDomainMask).first!
        let dir = appSupport.appendingPathComponent(VellumEnvironment.current.appSupportDirectoryName, isDirectory: true)
        try? fileManager.createDirectory(at: dir, withIntermediateDirectories: true)
        self.fileURL = dir.appendingPathComponent("app-list.json")
        load()
    }

    /// Test-only initializer that stores data at a custom URL instead of Application Support.
    /// Allows unit tests to use a temporary directory without polluting real app state.
    init(fileURL: URL) {
        self.fileURL = fileURL
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
            if apps[index].lucideIcon == nil {
                apps[index].lucideIcon = VAppIconGenerator.generate(from: name, type: appType ?? apps[index].appType).rawValue
            }
        } else {
            var item = AppItem(
                id: id,
                name: name,
                description: description,
                icon: icon,
                previewBase64: previewBase64,
                appType: appType,
                lastOpenedAt: Date()
            )
            item.lucideIcon = VAppIconGenerator.generate(from: name, type: appType).rawValue
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
    /// Removes local apps the daemon no longer reports.
    /// Always propagates daemon descriptions to existing apps when they differ.
    func syncFromDaemon(_ daemonApps: [AppItem_Daemon]) {
        let existingIds = Set(apps.map(\.id))
        let daemonIds = Set(daemonApps.map(\.id))
        var newCount = 0
        var updatedCount = 0

        // Remove local apps the daemon no longer reports
        let prunedCount = apps.count
        apps.removeAll { !daemonIds.contains($0.id) }
        let removedCount = prunedCount - apps.count

        for daemonApp in daemonApps {
            if existingIds.contains(daemonApp.id) {
                if let index = apps.firstIndex(where: { $0.id == daemonApp.id }),
                   apps[index].description != daemonApp.description {
                    apps[index].description = daemonApp.description
                    updatedCount += 1
                }
                continue
            }
            guard !removedAppIds.contains(daemonApp.id) else { continue }
            var item = AppItem(
                id: daemonApp.id,
                name: daemonApp.name,
                description: daemonApp.description,
                icon: daemonApp.icon,
                appType: daemonApp.appType,
                lastOpenedAt: Date(timeIntervalSince1970: TimeInterval(daemonApp.createdAt) / 1000.0)
            )
            item.lucideIcon = VAppIconGenerator.generate(from: daemonApp.name, type: daemonApp.appType).rawValue
            apps.append(item)
            newCount += 1
        }
        if newCount > 0 || updatedCount > 0 || removedCount > 0 {
            save()
            log.info("Synced from daemon: \(newCount) new, \(updatedCount) updated, \(removedCount) pruned")
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

    func updateAppIcon(id: String, icon: VIcon) {
        guard let index = apps.firstIndex(where: { $0.id == id }) else { return }
        apps[index].lucideIcon = icon.rawValue
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
        recomputeDerivedState()
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
            for index in apps.indices where apps[index].lucideIcon == nil {
                apps[index].lucideIcon = VAppIconGenerator.generate(from: apps[index].name, type: apps[index].appType).rawValue
                didMigrate = true
            }
            if didMigrate {
                save()
                log.info("Migrated app icons for existing entries")
            }
            recomputeDerivedState()
        } catch {
            log.error("Failed to load app list: \(error.localizedDescription)")
        }
    }

    /// Recompute `pinnedApps` and `displayApps` from the current `apps` array.
    /// Guarded by equality checks so SwiftUI only invalidates views when the
    /// derived lists actually change.
    private func recomputeDerivedState() {
        let newPinned = apps.filter(\.isPinned)
            .sorted { ($0.pinnedOrder ?? 0) < ($1.pinnedOrder ?? 0) }
        if newPinned != pinnedApps {
            pinnedApps = newPinned
        }

        let newDisplay = apps.sorted { a, b in
            if a.isPinned && b.isPinned {
                return (a.pinnedOrder ?? 0) < (b.pinnedOrder ?? 0)
            }
            if a.isPinned { return true }
            if b.isPinned { return false }
            return a.lastOpenedAt > b.lastOpenedAt
        }
        if newDisplay != displayApps {
            displayApps = newDisplay
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
