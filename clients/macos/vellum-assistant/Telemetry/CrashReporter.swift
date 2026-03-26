import Foundation
import os

private let log = Logger(
    subsystem: Bundle.main.bundleIdentifier ?? "com.vellum.vellum-assistant",
    category: "CrashReporter"
)

/// Detects macOS .ips / .crash logs from the previous app session and
/// auto-attaches them to the Sentry crash event on next launch.
///
/// Sentry's crash handler already captures the crash event itself; this
/// module adds the Apple-generated diagnostic report as an attachment for
/// richer symbolication context.
enum CrashReporter {
    private static let lastLaunchKey = "CrashReporter.lastLaunchDate"
    private static let seenCrashesKey = "CrashReporter.seenCrashes"

    /// Records the current launch timestamp. Call AFTER collecting pending
    /// crash logs so the next session can identify crashes from this one.
    static func recordLaunch() {
        UserDefaults.standard.set(Date(), forKey: lastLaunchKey)
    }

    /// Returns file URLs for the most recent unseen crash log and its
    /// companion files (e.g. `.tar.gz`, `.diag`). Returns an empty array
    /// when no crash log is found.
    static func pendingCrashLogURLs() -> [URL] {
        let diagURL = URL(fileURLWithPath: NSHomeDirectory())
            .appendingPathComponent("Library/Logs/DiagnosticReports")
        guard let items = try? FileManager.default.contentsOfDirectory(
            at: diagURL,
            includingPropertiesForKeys: [.contentModificationDateKey],
            options: [.skipsHiddenFiles]
        ) else { return [] }

        let lastLaunch = UserDefaults.standard.object(forKey: lastLaunchKey) as? Date
        let seenCrashes = Set(
            UserDefaults.standard.array(forKey: seenCrashesKey) as? [String] ?? []
        )

        let candidates = items
            .filter { url in
                let name = url.lastPathComponent
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

        guard let mostRecent = candidates.first else { return [] }

        let crashBaseName = mostRecent.deletingPathExtension().lastPathComponent
        let companionFiles = items.filter { url in
            let name = url.lastPathComponent
            guard name != mostRecent.lastPathComponent else { return false }
            return name.hasPrefix(crashBaseName)
        }

        return [mostRecent] + companionFiles
    }

    /// Marks crash log files as seen so they are not attached again.
    static func markAsSeen(_ urls: [URL]) {
        guard !urls.isEmpty else { return }
        var seen = UserDefaults.standard.array(forKey: seenCrashesKey) as? [String] ?? []
        for url in urls {
            let name = url.lastPathComponent
            if !seen.contains(name) {
                seen.append(name)
            }
        }
        if seen.count > 50 { seen = Array(seen.suffix(50)) }
        UserDefaults.standard.set(seen, forKey: seenCrashesKey)
        log.info("Auto-attached \(urls.count, privacy: .public) IPS crash report file(s) to Sentry scope")
    }
}
