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
            daemonClient.onPublishPageResponse = { [self] response in
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
                    if let viewModel = threadManager.activeViewModel {
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

            do {
                try daemonClient.sendPublishPage(html: html, title: title, appId: appId)
            } catch {
                sharing.isPublishing = false
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

        Task { @MainActor in
            let previousHandler = daemonClient.onBundleAppResponse
            daemonClient.onBundleAppResponse = { response in
                daemonClient.onBundleAppResponse = previousHandler
                sharing.shareFileURL = Self.cleanBundleURL(bundlePath: response.bundlePath, appName: response.manifest.name)
                sharing.isBundling = false
                sharing.showSharePicker = true
            }

            do {
                try daemonClient.sendBundleApp(appId: appId)
            } catch {
                sharing.isBundling = false
                daemonClient.onBundleAppResponse = previousHandler
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
            return cleanURL
        } catch {
            return originalURL
        }
    }
}
