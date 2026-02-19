import AppKit
import ApplicationServices
import os

private let log = Logger(subsystem: Bundle.main.bundleIdentifier ?? "com.vellum.vellum-assistant", category: "ChromeA11y")

/// Ensures Chrome exposes its full web content accessibility tree.
/// Chrome requires `--force-renderer-accessibility` to expose form inputs, links, etc.
/// Without it, only toolbar elements and some static text are visible via AX APIs.
final class ChromeAccessibilityHelper {

    /// Known Chrome-family bundle identifiers.
    static let chromeBundleIds: Set<String> = [
        "com.google.Chrome",
        "com.google.Chrome.canary",
        "com.brave.Browser",
        "com.microsoft.edgemac",
        "com.vivaldi.Vivaldi",
    ]

    /// Returns true if the given app is a Chromium-based browser.
    static func isChromium(_ app: NSRunningApplication) -> Bool {
        guard let bundleId = app.bundleIdentifier else { return false }
        return chromeBundleIds.contains(bundleId)
    }

    /// Check whether Chrome's AX tree includes web content (not just toolbar).
    /// A shallow tree (few interactive elements, none below the toolbar y-band) means
    /// Chrome isn't exposing renderer accessibility.
    static func hasWebContent(elements: [AXElement]) -> Bool {
        let flat = AccessibilityTreeEnumerator.flattenElements(elements)
        let interactive = flat.filter { AccessibilityTreeEnumerator.interactiveRoles.contains($0.role) }

        // Chrome toolbar sits at roughly y < 150. If ALL interactive elements are in
        // that band, we're only seeing the toolbar, not web content.
        let webInteractive = interactive.filter { $0.frame.midY > 200 }

        // Also check for web-specific roles that only appear with renderer accessibility
        let hasWebRoles = flat.contains { el in
            let role = el.role
            return role == "AXWebArea" || role == "AXForm" || role == "AXLandmarkMain"
                || role == "AXSection" || role == "AXArticle"
        }

        let result = !webInteractive.isEmpty || hasWebRoles
        log.info("hasWebContent: \(result) — \(interactive.count) interactive, \(webInteractive.count) below toolbar, hasWebRoles=\(hasWebRoles)")
        return result
    }

    /// Restart Chrome with custom command-line flags.
    /// Chrome's session restore will reopen all tabs.
    @MainActor
    static func restartChromeWithFlags(app: NSRunningApplication, flags: [String]) async -> Bool {
        guard let bundleId = app.bundleIdentifier,
              let bundleURL = app.bundleURL else {
            log.error("Cannot restart: missing bundle info")
            return false
        }

        log.info("Restarting \(bundleId, privacy: .public) with flags: \(flags, privacy: .public)")

        // Gracefully terminate — Chrome will save session state
        app.terminate()

        // Wait for Chrome to fully quit (up to 5 seconds)
        for _ in 0..<50 {
            try? await Task.sleep(nanoseconds: 100_000_000)
            if app.isTerminated { break }
        }

        if !app.isTerminated {
            log.warning("Chrome didn't quit gracefully, force-terminating")
            app.forceTerminate()
            try? await Task.sleep(nanoseconds: 500_000_000)
        }

        // Relaunch with flags
        do {
            try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
                let config = NSWorkspace.OpenConfiguration()
                config.arguments = flags
                config.activates = true
                NSWorkspace.shared.openApplication(at: bundleURL, configuration: config) { _, error in
                    if let error {
                        continuation.resume(throwing: error)
                    } else {
                        continuation.resume()
                    }
                }
            }
            log.info("Chrome relaunched with flags")
            try? await Task.sleep(nanoseconds: 3_000_000_000) // 3 seconds
            return true
        } catch {
            log.error("Failed to relaunch Chrome: \(error.localizedDescription)")
            return false
        }
    }

    /// Convenience: restart with just accessibility flag (backward compat).
    @MainActor
    static func restartChromeWithAccessibility(app: NSRunningApplication) async -> Bool {
        return await restartChromeWithFlags(app: app, flags: ["--force-renderer-accessibility"])
    }

    /// Launch a separate Chrome instance for CDP mode alongside any existing Chrome.
    /// Uses a dedicated user-data-dir so the user's normal Chrome is untouched.
    /// Launches via the binary directly (not NSWorkspace/Launch Services) to ensure
    /// a second instance is created instead of activating the existing one.
    @MainActor
    static func launchChromeForCDP() async -> Bool {
        // Chrome 145+ requires a non-default --user-data-dir for CDP to bind the debugging port.
        let chromeDataDir = NSHomeDirectory() + "/Library/Application Support/Google/Chrome-CDP"

        // Resolve Chrome binary dynamically via bundle ID to support non-standard install locations
        guard let chromeURL = NSWorkspace.shared.urlForApplication(withBundleIdentifier: "com.google.Chrome") else {
            log.error("Google Chrome not found via bundle ID")
            return false
        }
        let chromeBinary = chromeURL.appendingPathComponent("Contents/MacOS/Google Chrome").path

        guard FileManager.default.fileExists(atPath: chromeBinary) else {
            log.error("Chrome binary not found at \(chromeBinary)")
            return false
        }

        log.info("Launching separate Chrome instance for CDP with user-data-dir: \(chromeDataDir, privacy: .public)")

        do {
            let process = Process()
            process.executableURL = URL(fileURLWithPath: chromeBinary)
            process.arguments = [
                "--remote-debugging-port=9222",
                "--force-renderer-accessibility",
                "--user-data-dir=\(chromeDataDir)",
            ]
            process.standardOutput = FileHandle.nullDevice
            process.standardError = FileHandle.nullDevice
            try process.run()
            log.info("CDP Chrome instance launched (pid \(process.processIdentifier))")
        } catch {
            log.error("Failed to launch CDP Chrome: \(error.localizedDescription)")
            return false
        }

        // Poll CDP endpoint to confirm it's ready
        for _ in 0..<30 {
            try? await Task.sleep(nanoseconds: 500_000_000) // 500ms
            if let url = URL(string: "http://localhost:9222/json/version"),
               let (_, response) = try? await URLSession.shared.data(from: url),
               let httpResponse = response as? HTTPURLResponse,
               httpResponse.statusCode == 200 {
                log.info("CDP endpoint confirmed ready")
                return true
            }
        }
        log.warning("CDP endpoint not responding after Chrome launch")
        return false
    }

    /// Restart Chrome for CDP mode with both remote debugging and accessibility flags.
    /// Deprecated: prefer launchChromeForCDP() which doesn't kill the user's browser.
    @MainActor
    static func restartChromeForCDP(app: NSRunningApplication) async -> Bool {
        let chromeDataDir = NSHomeDirectory() + "/Library/Application Support/Google/Chrome-CDP"
        let success = await restartChromeWithFlags(app: app, flags: [
            "--remote-debugging-port=9222",
            "--force-renderer-accessibility",
            "--user-data-dir=\(chromeDataDir)"
        ])
        guard success else { return false }

        // Poll CDP endpoint to confirm it's ready
        for _ in 0..<30 {
            try? await Task.sleep(nanoseconds: 500_000_000) // 500ms
            if let url = URL(string: "http://localhost:9222/json/version"),
               let (_, response) = try? await URLSession.shared.data(from: url),
               let httpResponse = response as? HTTPURLResponse,
               httpResponse.statusCode == 200 {
                log.info("CDP endpoint confirmed ready")
                return true
            }
        }
        log.warning("CDP endpoint not responding after Chrome restart")
        return false
    }

    /// Find a running Chromium browser, preferring Google Chrome.
    static func findRunningChrome() -> NSRunningApplication? {
        // Check Google Chrome first since the UI references "Chrome" specifically,
        // then fall back to other Chromium browsers in deterministic order.
        let orderedIds = ["com.google.Chrome", "com.google.Chrome.canary",
                          "com.brave.Browser", "com.microsoft.edgemac", "com.vivaldi.Vivaldi"]
        for bundleId in orderedIds {
            if let app = NSRunningApplication.runningApplications(withBundleIdentifier: bundleId).first {
                return app
            }
        }
        return nil
    }
}

