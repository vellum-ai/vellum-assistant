@preconcurrency import AppKit
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

    /// Restart Chrome with `--force-renderer-accessibility` so the full AX tree is available.
    /// Chrome's built-in session restore will reopen all tabs.
    /// Returns true if Chrome was successfully restarted.
    @MainActor
    static func restartChromeWithAccessibility(app: NSRunningApplication) async -> Bool {
        guard let bundleId = app.bundleIdentifier,
              let bundleURL = app.bundleURL else {
            log.error("Cannot restart: missing bundle info")
            return false
        }

        log.info("Restarting \(bundleId, privacy: .public) with --force-renderer-accessibility")

        // Gracefully terminate — Chrome will save session state
        app.terminate()

        // Wait for Chrome to fully quit (up to 5 seconds)
        for _ in 0..<50 {
            try? await Task.sleep(nanoseconds: 100_000_000) // 100ms
            if app.isTerminated { break }
        }

        if !app.isTerminated {
            log.warning("Chrome didn't quit gracefully, force-terminating")
            app.forceTerminate()
            try? await Task.sleep(nanoseconds: 500_000_000)
        }

        // Relaunch with accessibility flag
        do {
            // Use completion handler to avoid Sendable warnings with NSWorkspace types
            try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
                let config = NSWorkspace.OpenConfiguration()
                config.arguments = ["--force-renderer-accessibility"]
                config.activates = true
                NSWorkspace.shared.openApplication(at: bundleURL, configuration: config) { _, error in
                    if let error {
                        continuation.resume(throwing: error)
                    } else {
                        continuation.resume()
                    }
                }
            }
            log.info("Chrome relaunched with accessibility flag")

            // Wait for Chrome to start and restore tabs
            try? await Task.sleep(nanoseconds: 3_000_000_000) // 3 seconds
            return true
        } catch {
            log.error("Failed to relaunch Chrome: \(error.localizedDescription)")
            return false
        }
    }
}
