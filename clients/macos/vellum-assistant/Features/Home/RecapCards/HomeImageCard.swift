import SwiftUI
import VellumAssistantShared

/// Recap card displaying a large image preview with Save and Find-a-New-One
/// action buttons. Uses `HomeRecapCardHeader` for the icon + title row.
struct HomeImageCard: View {
    let title: String
    let threadName: String?
    let image: NSImage?
    let onSave: () -> Void
    let onFindNew: () -> Void
    let onDismiss: (() -> Void)?

    init(
        title: String,
        threadName: String? = nil,
        image: NSImage? = nil,
        onSave: @escaping () -> Void,
        onFindNew: @escaping () -> Void,
        onDismiss: (() -> Void)? = nil
    ) {
        self.title = title
        self.threadName = threadName
        self.image = image
        self.onSave = onSave
        self.onFindNew = onFindNew
        self.onDismiss = onDismiss
    }

    var body: some View {
        VStack(spacing: VSpacing.md) {
            HomeRecapCardHeader(
                icon: .image,
                title: title,
                subtitle: threadName,
                showDismiss: true,
                onDismiss: onDismiss
            )

            imageArea

            actionButtons
        }
        .glassCard()
        .recapCardMaxWidth(fill: true)
    }

    // MARK: - Image area

    /// Large image preview filling the card width at 288pt tall with rounded
    /// corners. Shows a placeholder surface when no image is provided.
    private var imageArea: some View {
        Group {
            if let image {
                Image(nsImage: image)
                    .resizable()
                    .scaledToFill()
            } else {
                Rectangle()
                    .fill(VColor.surfaceActive)
            }
        }
        .frame(maxWidth: .infinity)
        .frame(height: 288)
        .clipShape(RoundedRectangle(cornerRadius: VRadius.xxl, style: .continuous))
    }

    // MARK: - Action buttons

    private var actionButtons: some View {
        HStack(spacing: VSpacing.sm) {
            VButton(label: "Save", style: .primary, size: .pillRegular, action: onSave)
            VButton(label: "Find a New One", style: .outlined, size: .pillRegular, action: onFindNew)
            Spacer()
        }
    }
}
