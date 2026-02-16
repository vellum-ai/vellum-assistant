import Foundation

public enum LayoutConfigStore {
    private static var configURL: URL {
        let appSupport = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first!
        return appSupport.appendingPathComponent("vellum-assistant/layout-config.json")
    }

    public static func load() -> LayoutConfig {
        guard let data = try? Data(contentsOf: configURL),
              let config = try? JSONDecoder().decode(LayoutConfig.self, from: data) else {
            return .default
        }
        return config
    }

    public static func save(_ config: LayoutConfig) {
        let url = configURL
        let dir = url.deletingLastPathComponent()
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        let encoder = JSONEncoder()
        encoder.outputFormatting = .prettyPrinted
        guard let data = try? encoder.encode(config) else { return }
        try? data.write(to: url, options: .atomic)
    }
}
