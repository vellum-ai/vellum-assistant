import SwiftUI
import VellumAssistantShared

/// Wrapper panel for the payment authorization detail panel kind.
///
/// Parses `PaymentAuthPanelData` from the feed item's `detailPanel.data`.
/// When an `imageUrl` is present (invoice/document image), loads and renders
/// it via `HomeDocumentPreview` with amount and recipient shown as
/// supplementary text above the image. Falls back gracefully to a text-only
/// card when data is nil or the image cannot be loaded.
struct HomePaymentAuthPanel: View {
    let item: FeedItem
    let onClose: () -> Void

    @State private var loadedImage: NSImage?

    private var panelData: PaymentAuthPanelData? {
        PaymentAuthPanelData.from(item.detailPanel?.data)
    }

    var body: some View {
        HomeDetailPanel(
            icon: nil,
            title: item.title,
            onDismiss: onClose,
            scrollable: false
        ) {
            VStack(alignment: .leading, spacing: 0) {
                // Supplementary amount/recipient info above the preview
                if panelData?.amount != nil || panelData?.recipient != nil {
                    HomeAuthDetailCard(
                        amount: panelData?.amount,
                        recipient: panelData?.recipient,
                        caption: panelData?.caption
                    )
                }

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
