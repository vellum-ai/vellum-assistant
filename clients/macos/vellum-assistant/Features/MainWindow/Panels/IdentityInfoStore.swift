import Foundation
import os

private let log = Logger(subsystem: Bundle.appBundleIdentifier, category: "IdentityInfoStore")

/// On-disk persistence for the per-assistant `IdentityInfo` cache. Mirrors
/// `LayoutConfigStore`: a single JSON document in Application Support, loaded
/// once at startup, rewritten atomically on every mutation.
///
/// The cache is keyed by `assistantId` so any UI surface that needs to render
/// an arbitrary assistant by id (e.g. the menu-bar switcher rendering names
/// for non-active rows) can read it without re-fetching from the gateway.
/// Entries are seeded as a side effect of `IdentityInfo.refreshCache()` /
/// `warmCache()`, so the cache fills in incrementally as the user visits
/// each assistant.
///
/// Decode failures fall back to an empty map and are logged but not
/// propagated — a corrupt or schema-mismatched cache should never block
/// app launch, since the cache is recoverable from live identity fetches.
enum IdentityInfoStore {
    private static var fileURL: URL {
        let appSupport = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first!
        return appSupport.appendingPathComponent("vellum-assistant/assistant-identities.json")
    }

    static func load() -> [String: IdentityInfo] {
        let url = fileURL
        let data: Data
        do {
            data = try Data(contentsOf: url)
        } catch let error as NSError where error.domain == NSCocoaErrorDomain && error.code == CocoaError.fileReadNoSuchFile.rawValue {
            return [:]
        } catch {
            log.error("Failed to read identity cache from \(url.path, privacy: .public): \(error)")
            return [:]
        }
        do {
            return try JSONDecoder().decode([String: IdentityInfo].self, from: data)
        } catch {
            log.error("Failed to decode identity cache: \(error)")
            return [:]
        }
    }

    static func save(_ cache: [String: IdentityInfo]) {
        let url = fileURL
        let dir = url.deletingLastPathComponent()
        do {
            try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        } catch {
            log.error("Failed to create identity cache directory at \(dir.path, privacy: .public): \(error)")
            return
        }
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
        let data: Data
        do {
            data = try encoder.encode(cache)
        } catch {
            log.error("Failed to encode identity cache: \(error)")
            return
        }
        do {
            try data.write(to: url, options: .atomic)
        } catch {
            log.error("Failed to write identity cache to \(url.path, privacy: .public): \(error)")
        }
    }
}
