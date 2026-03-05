import Foundation

/// Detects macOS crash logs from the previous app session and surfaces them
/// so the user can opt to send a report with the log attached.
enum CrashReporter {
    private static let lastLaunchKey = "CrashReporter.lastLaunchDate"
    private static let seenCrashesKey = "CrashReporter.seenCrashes"

    /// Records the current launch timestamp. Call this AFTER `pendingCrashLog()`
    /// on every launch so the next session can identify crashes from this one.
    static func recordLaunch() {
        UserDefaults.standard.set(Date(), forKey: lastLaunchKey)
    }

    /// Returns the most recent unseen crash log from the previous session, or nil.
    static func pendingCrashLog() -> (url: URL, content: String)? {
        let diagURL = URL(fileURLWithPath: NSHomeDirectory())
            .appendingPathComponent("Library/Logs/DiagnosticReports")
        guard let items = try? FileManager.default.contentsOfDirectory(
            at: diagURL,
            includingPropertiesForKeys: [.contentModificationDateKey],
            options: [.skipsHiddenFiles]
        ) else { return nil }

        let lastLaunch = UserDefaults.standard.object(forKey: lastLaunchKey) as? Date
        let seenCrashes = Set(
            UserDefaults.standard.array(forKey: seenCrashesKey) as? [String] ?? []
        )

        let candidates = items
            .filter { url in
                let name = url.lastPathComponent
                // Match only the main app executable, not vellum-cli, vellum-daemon, etc.
                let isOurApp = name.lowercased().hasPrefix("vellum-assistant")
                let isCrashFile = url.pathExtension == "crash" || url.pathExtension == "ips"
                guard isOurApp && isCrashFile else { return false }
                guard !seenCrashes.contains(name) else { return false }
                let modDate = (try? url.resourceValues(
                    forKeys: [.contentModificationDateKey]
                ))?.contentModificationDate
                if let lastLaunch, let modDate {
                    return modDate > lastLaunch
                }
                // No prior launch recorded: surface crashes from the last 24 hours.
                if let modDate {
                    return Date().timeIntervalSince(modDate) < 86_400
                }
                return false
            }
            .sorted { a, b in
                let dateA = (try? a.resourceValues(
                    forKeys: [.contentModificationDateKey]
                ))?.contentModificationDate ?? .distantPast
                let dateB = (try? b.resourceValues(
                    forKeys: [.contentModificationDateKey]
                ))?.contentModificationDate ?? .distantPast
                return dateA > dateB
            }

        guard let mostRecent = candidates.first,
              let content = try? String(contentsOf: mostRecent, encoding: .utf8)
        else { return nil }

        return (url: mostRecent, content: content)
    }

    /// Marks a crash log as seen so it is not surfaced again on future launches.
    static func markAsSeen(_ url: URL) {
        var seen = UserDefaults.standard.array(forKey: seenCrashesKey) as? [String] ?? []
        seen.append(url.lastPathComponent)
        if seen.count > 50 { seen = Array(seen.suffix(50)) }
        UserDefaults.standard.set(seen, forKey: seenCrashesKey)
    }
}
