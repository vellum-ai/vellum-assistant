import SwiftUI
import VellumAssistantShared

/// Recap card displaying a large image preview with Save and Open in Finder
/// action buttons. Uses
/// `HomeRecapCardHeader` for the icon + title row.
struct HomeImageCard: View {
    let title: String
    let threadName: String?
    let image: NSImage?
    let onSave: () -> Void
    let onOpenInFinder: () -> Void
    let onDismiss: (() -> Void)?

    init(
        title: String,
        threadName: String? = nil,
        image: NSImage? = nil,
        onSave: @escaping () -> Void,
        onOpenInFinder: @escaping () -> Void,
        onDismiss: (() -> Void)? = nil
    ) {
        self.title = title
        self.threadName = threadName
        self.image = image
        self.onSave = onSave
        self.onOpenInFinder = onOpenInFinder
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
        .recapCardGlass()
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
            Button(action: onSave) {
                Text("Save")
                    .font(VFont.bodySmallEmphasised)
                    .foregroundStyle(VColor.contentInset)
                    .padding(.horizontal, 10)
                    .padding(.vertical, 6)
                    .frame(height: 32)
                    .background(Capsule().fill(VColor.primaryBase))
            }
            .buttonStyle(.plain)

            Button(action: onOpenInFinder) {
                Text("Find a New One")
                    .font(VFont.bodySmallEmphasised)
                    .foregroundStyle(VColor.contentDefault)
                    .padding(.horizontal, 10)
                    .padding(.vertical, 6)
                    .frame(height: 32)
                    .background(
                        Capsule()
                            .strokeBorder(VColor.borderBase, lineWidth: 1)
                    )
            }
            .buttonStyle(.plain)

            Spacer()
        }
    }
}
