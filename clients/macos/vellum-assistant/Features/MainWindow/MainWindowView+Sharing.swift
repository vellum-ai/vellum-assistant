import AppKit
import SwiftUI
import VellumAssistantShared

// MARK: - Sharing & Publishing

extension MainWindowView {

    func pageURL(for appId: String) -> URL? {
        let gatewayBaseUrl = settingsStore.localGatewayTarget
        return URL(string: "\(gatewayBaseUrl)/pages/\(appId)")
    }

    func publishPage(html: String, title: String?, appId: String? = nil) {
        guard !sharing.isPublishing else { return }
        sharing.isPublishing = true
        sharing.publishError = nil

        Task { @MainActor in
            let publishClient = PublishClient()
            guard let response = try? await publishClient.publishPage(html: html, title: title, appId: appId) else {
                sharing.isPublishing = false
                return
            }

            sharing.isPublishing = false
            if response.success, let url = response.publicUrl {
                sharing.publishedUrl = url
                NSPasteboard.general.clearContents()
                NSPasteboard.general.setString(url, forType: .string)
            } else if response.errorCode == "credentials_missing" {
                // Save pending publish for auto-retry after credential setup
                sharing.pendingPublish = (html: html, title: title, appId: appId)
                // Open the chat dock so the user can see the credential setup flow.
                // Use the publish target's appId (not windowState.selection) to avoid
                // a race where the user navigates away before this async callback fires.
                if let targetAppId = appId {
                    enterAppEditing(appId: targetAppId)
                } else if case .app(let currentAppId) = windowState.selection {
                    enterAppEditing(appId: currentAppId)
                }
                // Inject message into active session to trigger assistant-driven setup
                if let viewModel = conversationManager.activeViewModel {
                    viewModel.inputText = "I need to set up a Vercel API token to publish my app. Please load the vercel-token-setup skill and follow its instructions."
                    viewModel.sendMessage()
                }
                startCredentialPollForPublish()
            } else if let error = response.error, error != "Cancelled" {
                sharing.publishError = error
                // Auto-dismiss error after 5 seconds
                sharing.errorDismissTask?.cancel()
                sharing.errorDismissTask = Task { @MainActor in
                    try? await Task.sleep(for: .seconds(5))
                    guard !Task.isCancelled else { return }
                    if sharing.publishError == error {
                        withAnimation(VAnimation.standard) { sharing.publishError = nil }
                    }
                }
            }
        }
    }

    /// Polls the daemon for Vercel credential availability every 3 seconds.
    /// When the credential appears, auto-retries the pending publish.
    /// Times out after 5 minutes.
    func startCredentialPollForPublish() {
        sharing.credentialPollTimer?.invalidate()
        let startTime = Date()
        let timeout: TimeInterval = 300 // 5 minutes

        // Preserve SettingsStore's handler so it continues receiving updates
        // after polling ends. Without this, the poll closure permanently
        // overwrites SettingsStore's onVercelApiConfigResponse and hasVercelKey
        // is never updated again.
        sharing.previousVercelHandler = daemonClient.onVercelApiConfigResponse
        let previousHandler = sharing.previousVercelHandler

        sharing.credentialPollTimer = Timer.scheduledTimer(withTimeInterval: 3, repeats: true) { [self] timer in
            Task { @MainActor in
                // Timeout check
                if Date().timeIntervalSince(startTime) > timeout {
                    timer.invalidate()
                    sharing.credentialPollTimer = nil
                    sharing.pendingPublish = nil
                    daemonClient.onVercelApiConfigResponse = previousHandler
                    sharing.previousVercelHandler = nil
                    return
                }

                // Poll for credential
                daemonClient.onVercelApiConfigResponse = { [self] response in
                    // Forward to the previous handler (e.g. SettingsStore) so it
                    // stays in sync with credential state during polling.
                    previousHandler?(response)

                    if response.success && response.hasToken, let pending = sharing.pendingPublish {
                        timer.invalidate()
                        sharing.credentialPollTimer = nil
                        sharing.pendingPublish = nil
                        daemonClient.onVercelApiConfigResponse = previousHandler
                        sharing.previousVercelHandler = nil
                        // Auto-retry publish with saved params
                        publishPage(html: pending.html, title: pending.title, appId: pending.appId)
                    }
                }
                do {
                    try daemonClient.sendVercelApiConfig(action: "get")
                } catch {
                    // Polling failure is non-fatal; will retry on next tick
                }
            }
        }
    }

    func bundleAndShare(appId: String) {
        guard !sharing.isBundling else { return }
        sharing.isBundling = true
        sharing.shareAppId = appId

        Task { @MainActor in
            let response = await AppsClient().bundleApp(appId: appId)
            if let response {
                let url = Self.cleanBundleURL(bundlePath: response.bundlePath, appName: response.manifest.name)
                Self.applyFileIcon(to: url, iconBase64: response.iconImageBase64, emojiIcon: response.manifest.icon, appName: response.manifest.name)
                sharing.shareFileURL = url
                sharing.shareAppName = response.manifest.name
                sharing.shareAppIcon = Self.buildAppIcon(iconBase64: response.iconImageBase64, emojiIcon: response.manifest.icon, appName: response.manifest.name)
                sharing.isBundling = false
                sharing.showSharePicker = true
            } else {
                sharing.isBundling = false
            }
        }
    }

    /// Creates a hardlink with a clean display name for the share sheet.
    /// Falls back to the original path if linking fails.
    static func cleanBundleURL(bundlePath: String, appName: String) -> URL {
        let originalURL = URL(fileURLWithPath: bundlePath)
        let cleanName = appName
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: ":", with: "_")
            .trimmingCharacters(in: .whitespacesAndNewlines)
        guard !cleanName.isEmpty else { return originalURL }

        let cleanURL = originalURL.deletingLastPathComponent().appendingPathComponent("\(cleanName).vellum")
        try? FileManager.default.removeItem(at: cleanURL)
        do {
            try FileManager.default.linkItem(at: originalURL, to: cleanURL)
            // Hide .vellum extension in Finder so it displays as just the app name
            var resourceURL = cleanURL
            try? resourceURL.setResourceValues({
                var v = URLResourceValues()
                v.hasHiddenExtension = true
                return v
            }())
            return cleanURL
        } catch {
            return originalURL
        }
    }

    /// Builds an NSImage for the app icon from base64 PNG, emoji, or app initial fallback.
    /// Returns the image without applying it to a file — useful for the custom share panel header.
    static func buildAppIcon(iconBase64: String?, emojiIcon: String?, appName: String) -> NSImage? {
        if let base64 = iconBase64,
           let data = Data(base64Encoded: base64),
           let image = NSImage(data: data) {
            return roundedIcon(from: image)
        }

        let glyph = (emojiIcon.flatMap { $0.isEmpty ? nil : $0 })
            ?? String(appName.trimmingCharacters(in: .whitespacesAndNewlines).prefix(1)).uppercased()
        if !glyph.isEmpty {
            return renderEmojiIcon(emoji: glyph, size: 512)
        }
        return nil
    }

    /// Sets a custom icon on the file so the share sheet shows it instead of a blank document.
    /// Prefers the AI-generated icon (base64 PNG), falls back to rendering the emoji or app initial.
    /// All icons are clipped to a rounded rect so Finder shows transparent corners.
    static func applyFileIcon(to url: URL, iconBase64: String?, emojiIcon: String?, appName: String) {
        if let base64 = iconBase64,
           let data = Data(base64Encoded: base64),
           let image = NSImage(data: data) {
            NSWorkspace.shared.setIcon(roundedIcon(from: image), forFile: url.path, options: [])
            return
        }

        // Fallback: render the emoji or first letter as an icon
        let glyph = (emojiIcon.flatMap { $0.isEmpty ? nil : $0 })
            ?? String(appName.trimmingCharacters(in: .whitespacesAndNewlines).prefix(1)).uppercased()
        if !glyph.isEmpty {
            let image = renderEmojiIcon(emoji: glyph, size: 512)
            NSWorkspace.shared.setIcon(image, forFile: url.path, options: [])
        }
    }

    /// Clips an image to a rounded rect with transparent corners, matching macOS icon shape.
    private static func roundedIcon(from source: NSImage, size: CGFloat = 512) -> NSImage {
        let cornerRadius = size * 0.22
        return NSImage(size: NSSize(width: size, height: size), flipped: false) { rect in
            let path = NSBezierPath(roundedRect: rect, xRadius: cornerRadius, yRadius: cornerRadius)
            path.addClip()
            source.draw(in: rect, from: .zero, operation: .sourceOver, fraction: 1.0)
            return true
        }
    }

    /// Renders a glyph (emoji or letter) as a square icon image with a gradient background.
    /// Uses NSImage(size:flipped:drawingHandler:) to avoid deprecated lockFocus on macOS 14+.
    private static func renderEmojiIcon(emoji: String, size: CGFloat) -> NSImage {
        return NSImage(size: NSSize(width: size, height: size), flipped: false) { rect in
            let cornerRadius = size * 0.22
            let path = NSBezierPath(roundedRect: rect, xRadius: cornerRadius, yRadius: cornerRadius)

            // Gradient background — use a stable hash for consistent colors per glyph
            var hasher = Hasher()
            hasher.combine(emoji)
            let hash = hasher.finalize() & Int.max
            let hue = CGFloat(hash % 360) / 360.0
            let topColor = NSColor(hue: hue, saturation: 0.6, brightness: 0.85, alpha: 1.0)
            let bottomColor = NSColor(
                hue: (hue + 0.08).truncatingRemainder(dividingBy: 1.0),
                saturation: 0.7, brightness: 0.65, alpha: 1.0
            )
            if let gradient = NSGradient(starting: topColor, ending: bottomColor) {
                gradient.draw(in: path, angle: -90)
            }

            // Draw the glyph centered
            let fontSize = size * 0.55
            let attributes: [NSAttributedString.Key: Any] = [
                .font: NSFont.systemFont(ofSize: fontSize),
            ]
            let emojiString = NSAttributedString(string: emoji, attributes: attributes)
            let emojiSize = emojiString.size()
            let origin = NSPoint(
                x: (size - emojiSize.width) / 2,
                y: (size - emojiSize.height) / 2
            )
            emojiString.draw(at: origin)
            return true
        }
    }
}
