import Foundation

/// Detects macOS crash logs from the previous app session and surfaces them
/// so the user can opt to send a report with the log attached.
enum CrashReporter {
    private static let lastLaunchKey = "CrashReporter.lastLaunchDate"
    private static let seenCrashesKey = "CrashReporter.seenCrashes"

    /// The bundle identifier used to match crash files to this app.
    private static let appBundleID = Bundle.main.bundleIdentifier ?? "com.vellum.vellum-assistant"

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
                let isCrashFile = url.pathExtension == "crash" || url.pathExtension == "ips"
                guard isCrashFile else { return false }
                guard !seenCrashes.contains(name) else { return false }
                let modDate = (try? url.resourceValues(
                    forKeys: [.contentModificationDateKey]
                ))?.contentModificationDate
                if let lastLaunch, let modDate {
                    guard modDate > lastLaunch else { return false }
                } else if let modDate {
                    // No prior launch recorded: surface crashes from the last 24 hours.
                    guard Date().timeIntervalSince(modDate) < 86_400 else { return false }
                } else {
                    return false
                }
                // Match by bundle ID inside the file rather than filename prefix,
                // because macOS names crash files after the product name which can
                // be anything (e.g. "Vellum", "CARTMAN BRAAAAAAH", "vellum-assistant").
                return isOurCrashFile(url)
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

    /// Checks whether a `.ips` or `.crash` file belongs to this app by reading
    /// the first line (`.ips` files have a JSON header with `bundleID`) or
    /// scanning for an `Identifier:` line (`.crash` format).
    private static func isOurCrashFile(_ url: URL) -> Bool {
        guard let handle = try? FileHandle(forReadingFrom: url) else { return false }
        defer { try? handle.close() }
        // Read only the first 2 KB — the bundle ID is always near the top.
        guard let chunk = try? handle.read(upToCount: 2048),
              let header = String(data: chunk, encoding: .utf8) else { return false }

        if url.pathExtension == "ips" {
            // .ips files: first line is JSON with "bundleID" key.
            if let firstLine = header.split(separator: "\n", maxSplits: 1).first {
                return firstLine.contains("\"bundleID\":\"\(appBundleID)\"")
                    || firstLine.contains("\"bundleID\": \"\(appBundleID)\"")
            }
        }
        // .crash files: look for "Identifier: com.vellum.vellum-assistant"
        return header.contains("Identifier:\t\(appBundleID)")
            || header.contains("Identifier: \(appBundleID)")
    }

    /// Marks a crash log as seen so it is not surfaced again on future launches.
    static func markAsSeen(_ url: URL) {
        var seen = UserDefaults.standard.array(forKey: seenCrashesKey) as? [String] ?? []
        seen.append(url.lastPathComponent)
        if seen.count > 50 { seen = Array(seen.suffix(50)) }
        UserDefaults.standard.set(seen, forKey: seenCrashesKey)
    }
}
