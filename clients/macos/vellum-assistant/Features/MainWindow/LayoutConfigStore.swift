import Foundation
import VellumAssistantShared
import os

private let log = Logger(subsystem: Bundle.appBundleIdentifier, category: "LayoutConfigStore")

public enum LayoutConfigStore {
    private static var configURL: URL {
        let appSupport = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first!
        return appSupport
            .appendingPathComponent(VellumEnvironment.current.appSupportDirectoryName, isDirectory: true)
            .appendingPathComponent("layout-config.json")
    }

    public static func load() -> LayoutConfig {
        let url = configURL
        let data: Data
        do {
            data = try Data(contentsOf: url)
        } catch let error as NSError where error.domain == NSCocoaErrorDomain && error.code == CocoaError.fileReadNoSuchFile.rawValue {
            log.info("No layout config at \(url.path, privacy: .public), using defaults")
            return .default
        } catch {
            log.error("Failed to read layout config data from \(url.path, privacy: .public): \(error)")
            return .default
        }
        do {
            return try JSONDecoder().decode(LayoutConfig.self, from: data)
        } catch {
            log.error("Failed to decode layout config: \(error)")
            return .default
        }
    }

    public static func save(_ config: LayoutConfig) {
        let url = configURL
        let dir = url.deletingLastPathComponent()
        do {
            try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        } catch {
            log.error("Failed to create layout config directory at \(dir.path, privacy: .public): \(error)")
            return
        }
        let encoder = JSONEncoder()
        encoder.outputFormatting = .prettyPrinted
        let data: Data
        do {
            data = try encoder.encode(config)
        } catch {
            log.error("Failed to encode layout config: \(error)")
            return
        }
        do {
            try data.write(to: url, options: .atomic)
        } catch {
            log.error("Failed to write layout config to \(url.path, privacy: .public): \(error)")
        }
    }
}
