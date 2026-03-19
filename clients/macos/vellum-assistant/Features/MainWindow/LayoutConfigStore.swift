import Foundation
import os

private let log = Logger(subsystem: Bundle.main.bundleIdentifier ?? "com.vellum.vellum-assistant", category: "LayoutConfigStore")

public enum LayoutConfigStore {
    private static var configURL: URL {
        let appSupport = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first!
        return appSupport.appendingPathComponent("vellum-assistant/layout-config.json")
    }

    public static func load() -> LayoutConfig {
        let path = configURL.path
        guard FileManager.default.fileExists(atPath: path) else {
            log.info("No layout config file at \(path), using default")
            return .default
        }
        let data: Data
        do {
            data = try Data(contentsOf: configURL)
        } catch {
            log.error("Failed to read layout config data from \(path): \(error)")
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
            log.error("Failed to create layout config directory at \(dir.path): \(error)")
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
            log.error("Failed to write layout config to \(url.path): \(error)")
        }
    }
}
