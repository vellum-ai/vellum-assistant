import AppKit
import VellumAssistantShared

/// Groups sharing/publishing state into a single @Observable object so that
/// changes to individual properties only invalidate views that read them,
/// rather than triggering a full MainWindowView recomputation.
@MainActor @Observable
final class SharingState {
    var showSharePicker = false
    var isBundling = false
    var shareFileURL: URL?
    var isPublishing = false
    var publishedUrl: String?
    var publishError: String?

    func publishPage(html: String, title: String?, appId: String? = nil, daemonClient: DaemonClient) {
        guard !isPublishing else { return }
        isPublishing = true
        publishError = nil

        Task { @MainActor [weak self] in
            daemonClient.onPublishPageResponse = { [weak self] response in
                guard let self else { return }
                isPublishing = false
                if response.success, let url = response.publicUrl {
                    publishedUrl = url
                    NSPasteboard.general.clearContents()
                    NSPasteboard.general.setString(url, forType: .string)
                } else if let error = response.error, error != "Cancelled" {
                    publishError = error
                    DispatchQueue.main.asyncAfter(deadline: .now() + 5) { [weak self] in
                        guard let self else { return }
                        if publishError == error {
                            publishError = nil
                        }
                    }
                }
            }

            do {
                try daemonClient.sendPublishPage(html: html, title: title, appId: appId)
            } catch {
                self?.isPublishing = false
            }
        }
    }

    func bundleAndShare(appId: String, daemonClient: DaemonClient) {
        guard !isBundling else { return }
        isBundling = true

        Task { @MainActor [weak self] in
            daemonClient.onBundleAppResponse = { [weak self] response in
                guard let self else { return }
                shareFileURL = URL(fileURLWithPath: response.bundlePath)
                isBundling = false
                showSharePicker = true
            }

            do {
                try daemonClient.sendBundleApp(appId: appId)
            } catch {
                self?.isBundling = false
            }
        }
    }
}
