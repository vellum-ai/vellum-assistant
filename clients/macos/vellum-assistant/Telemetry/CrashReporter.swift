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
    /// Also returns companion file URLs (e.g. `.tar.gz`, `.diag`) that macOS may
    /// generate alongside the crash log with matching base name prefixes.
    static func pendingCrashLog() -> (url: URL, content: String, companionFiles: [URL])? {
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
                let lower = name.lowercased()
                // Match the main app: macOS names crash files after the product
                // name ("Vellum-…") or the executable ("vellum-assistant-…").
                // Exclude vellum-cli, vellum-daemon, etc.
                let excluded = lower.hasPrefix("vellum-daemon")
                    || lower.hasPrefix("vellum-cli")
                    || lower.hasPrefix("vellumql")
                let isOurApp = !excluded
                    && (lower.hasPrefix("vellum-assistant") || lower.hasPrefix("vellum-"))
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

        // Look for companion files that macOS generates alongside crash logs
        // (e.g. .tar.gz spindump archives, .diag files) by matching the base
        // name prefix before the extension.
        let crashBaseName = mostRecent.deletingPathExtension().lastPathComponent
        let companionFiles = items.filter { url in
            let name = url.lastPathComponent
            guard name != mostRecent.lastPathComponent else { return false }
            return name.hasPrefix(crashBaseName)
        }

        return (url: mostRecent, content: content, companionFiles: companionFiles)
    }

    /// Marks a crash log as seen so it is not surfaced again on future launches.
    static func markAsSeen(_ url: URL) {
        var seen = UserDefaults.standard.array(forKey: seenCrashesKey) as? [String] ?? []
        seen.append(url.lastPathComponent)
        if seen.count > 50 { seen = Array(seen.suffix(50)) }
        UserDefaults.standard.set(seen, forKey: seenCrashesKey)
    }
}
