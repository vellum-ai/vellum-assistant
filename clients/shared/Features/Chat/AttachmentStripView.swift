import SwiftUI

/// Horizontal strip of thumbnail chips for pending message attachments.
public struct AttachmentStripView: View {
    @ObservedObject public var viewModel: ChatViewModel

    public init(viewModel: ChatViewModel) {
        self.viewModel = viewModel
    }

    public var body: some View {
        if viewModel.pendingAttachments.isEmpty {
            EmptyView()
        } else {
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 8) {
                    ForEach(viewModel.pendingAttachments) { attachment in
                        AttachmentChip(attachment: attachment) {
                            viewModel.removeAttachment(id: attachment.id)
                        }
                    }
                }
                .padding(.horizontal)
            }
            .frame(height: 72)
        }
    }
}

private struct AttachmentChip: View {
    let attachment: ChatAttachment
    let onRemove: () -> Void

    var body: some View {
        ZStack(alignment: .topTrailing) {
            // Thumbnail
            thumbnailView
                .frame(width: 60, height: 60)
                .clipShape(RoundedRectangle(cornerRadius: 8))
            // Remove button
            Button(action: onRemove) {
                VIconView(.circleX, size: 14)
                    .foregroundStyle(VColor.auxWhite)
                    .background(Circle().fill(VColor.auxBlack.opacity(0.6)))
            }
            .accessibilityLabel("Remove \(attachment.filename)")
            .offset(x: 6, y: -6)
        }
    }

    @ViewBuilder
    private var thumbnailView: some View {
        #if os(macOS)
        if let nsImage = attachment.thumbnailImage {
            Image(nsImage: nsImage)
                .resizable()
                .scaledToFill()
        } else {
            placeholderView
        }
        #else
        if let uiImage = attachment.thumbnailImage {
            Image(uiImage: uiImage)
                .resizable()
                .scaledToFill()
        } else {
            placeholderView
        }
        #endif
    }

    private var placeholderView: some View {
        RoundedRectangle(cornerRadius: 8)
            .fill(.quaternary)
            .overlay {
                VIconView(.file, size: 14)
                    .foregroundStyle(.secondary)
            }
    }
}
