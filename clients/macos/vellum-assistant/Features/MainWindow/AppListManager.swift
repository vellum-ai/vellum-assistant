import Foundation
import os

private let log = Logger(subsystem: Bundle.main.bundleIdentifier ?? "com.vellum.vellum-assistant", category: "AppListManager")

@MainActor
final class AppListManager: ObservableObject {

    struct AppItem: Identifiable, Codable, Hashable {
        let id: String
        var name: String
        var icon: String?
        var previewBase64: String?
        var appType: String?
        var lastOpenedAt: Date
        var isPinned: Bool = false
        var pinnedOrder: Int? = nil
    }

    @Published var apps: [AppItem] = []

    private let fileURL: URL

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

    func recordAppOpen(id: String, name: String, icon: String? = nil, previewBase64: String? = nil, appType: String? = nil) {
        if let index = apps.firstIndex(where: { $0.id == id }) {
            apps[index].lastOpenedAt = Date()
            apps[index].name = name
            if let icon { apps[index].icon = icon }
            if let previewBase64 { apps[index].previewBase64 = previewBase64 }
            if let appType { apps[index].appType = appType }
        } else {
            let item = AppItem(
                id: id,
                name: name,
                icon: icon,
                previewBase64: previewBase64,
                appType: appType,
                lastOpenedAt: Date()
            )
            apps.append(item)
        }
        save()
    }

    func pinApp(id: String) {
        guard let index = apps.firstIndex(where: { $0.id == id }) else { return }
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

    func removeApp(id: String) {
        apps.removeAll { $0.id == id }
        save()
    }

    // MARK: - Persistence

    private func save() {
        do {
            let encoder = JSONEncoder()
            encoder.dateEncodingStrategy = .iso8601
            encoder.outputFormatting = .prettyPrinted
            let data = try encoder.encode(apps)
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
            apps = try decoder.decode([AppItem].self, from: data)
            log.info("Loaded \(self.apps.count) app list entries")
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
