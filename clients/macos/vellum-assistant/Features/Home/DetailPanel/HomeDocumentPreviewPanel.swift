import SwiftUI
import VellumAssistantShared

/// Wrapper panel for the document preview detail panel kind.
///
/// Parses `DocumentPreviewPanelData` from the feed item's `detailPanel.data`.
/// When an `imageUrl` is present, loads the image asynchronously and renders
/// it via `HomeDocumentPreview`. Falls back to the placeholder caption when
/// the URL is absent or the download fails.
struct HomeDocumentPreviewPanel: View {
    let item: FeedItem
    let onClose: () -> Void

    @State private var loadedImage: NSImage?

    private var panelData: DocumentPreviewPanelData? {
        DocumentPreviewPanelData.from(item.detailPanel?.data)
    }

    var body: some View {
        HomeDetailPanel(
            icon: nil,
            title: item.title,
            onDismiss: onClose,
            scrollable: false
        ) {
            HomeDocumentPreview(
                image: loadedImage,
                placeholderCaption: panelData?.caption ?? item.summary,
                actions: [
                    HomeDocumentPreview.Action(
                        label: "Action",
                        style: .outlined,
                        action: { onClose() }
                    ),
                    HomeDocumentPreview.Action(
                        label: "Action",
                        style: .primary,
                        action: { onClose() }
                    ),
                ]
            )
        }
        .task(id: panelData?.imageUrl) {
            await loadImageIfNeeded()
        }
    }

    private func loadImageIfNeeded() async {
        guard let urlString = panelData?.imageUrl,
              let url = URL(string: urlString) else { return }
        do {
            let (data, _) = try await URLSession.shared.data(from: url)
            guard !Task.isCancelled else { return }
            if let image = NSImage(data: data) {
                loadedImage = image
            }
        } catch {
            // Download failed — leave loadedImage nil so the placeholder renders.
        }
    }
}
