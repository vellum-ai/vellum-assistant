#if canImport(UIKit)
import SwiftUI
import VellumAssistantShared

/// Horizontal strip of thumbnail chips for pending message attachments.
struct AttachmentStripView: View {
    @ObservedObject var viewModel: ChatViewModel

    var body: some View {
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
            if let uiImage = attachment.thumbnailImage {
                Image(uiImage: uiImage)
                    .resizable()
                    .scaledToFill()
                    .frame(width: 60, height: 60)
                    .clipShape(RoundedRectangle(cornerRadius: 8))
            } else {
                RoundedRectangle(cornerRadius: 8)
                    .fill(.quaternary)
                    .frame(width: 60, height: 60)
                    .overlay {
                        Image(systemName: "doc.fill")
                            .foregroundStyle(.secondary)
                    }
            }
            // Remove button
            Button(action: onRemove) {
                Image(systemName: "xmark.circle.fill")
                    .symbolRenderingMode(.palette)
                    .foregroundStyle(.white, .black.opacity(0.6))
            }
            .offset(x: 6, y: -6)
        }
    }
}
#endif
