import Foundation

enum SharedUserDefaults {
    private static let legacySuiteName = "com.vellum.vellum-assistant.swiftpackage"
    private static let lock = NSLock()
    private static var didMigrateLegacySuite = false

    static var standard: UserDefaults {
        migrateLegacySuiteIfNeeded()
        return .standard
    }

    static func resetLegacyMigrationStateForTests() {
        lock.lock()
        defer { lock.unlock() }
        didMigrateLegacySuite = false
    }

    private static func migrateLegacySuiteIfNeeded() {
        lock.lock()
        defer { lock.unlock() }

        guard !didMigrateLegacySuite else { return }
        didMigrateLegacySuite = true

        guard let legacyDefaults = UserDefaults(suiteName: legacySuiteName) else { return }
        let legacyValues = legacyDefaults.dictionaryRepresentation()
        guard !legacyValues.isEmpty else { return }

        let standardDefaults = UserDefaults.standard
        for (key, value) in legacyValues {
            if standardDefaults.object(forKey: key) == nil {
                standardDefaults.set(value, forKey: key)
            }
            legacyDefaults.removeObject(forKey: key)
        }
    }
}
