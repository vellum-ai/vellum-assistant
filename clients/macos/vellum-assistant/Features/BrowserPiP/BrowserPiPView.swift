import SwiftUI
import VellumAssistantShared

struct BrowserPiPView: View {
    @ObservedObject var manager: BrowserPiPManager

    var body: some View {
        VStack(spacing: 0) {
            // URL bar + status
            HStack(spacing: 6) {
                Circle()
                    .fill(statusColor)
                    .frame(width: 8, height: 8)
                Text(manager.currentUrl)
                    .font(.system(size: 11, design: .monospaced))
                    .lineLimit(1)
                    .truncationMode(.middle)
                    .foregroundColor(.secondary)
                Spacer()
            }
            .padding(.horizontal, 8)
            .padding(.vertical, 6)
            .background(Color(NSColor.windowBackgroundColor))

            Divider()

            // Frame
            ZStack {
                if let frame = manager.currentFrame {
                    Image(nsImage: frame)
                        .resizable()
                        .aspectRatio(contentMode: .fit)
                } else {
                    Color(NSColor.controlBackgroundColor)
                    Text("Waiting for browser...")
                        .font(.system(size: 12))
                        .foregroundColor(.secondary)
                }

                // Highlight overlays
                if !manager.highlights.isEmpty, let _ = manager.currentFrame {
                    GeometryReader { geometry in
                        ForEach(manager.highlights) { highlight in
                            let scaled = scaleHighlight(highlight, viewSize: geometry.size, frameSize: manager.frameSize)
                            RoundedRectangle(cornerRadius: 2)
                                .stroke(Color.blue, lineWidth: 2)
                                .background(RoundedRectangle(cornerRadius: 2).fill(Color.blue.opacity(0.1)))
                                .frame(width: scaled.width, height: scaled.height)
                                .position(x: scaled.midX, y: scaled.midY)
                        }
                    }
                }

                // Action text overlay
                if let action = manager.actionText {
                    VStack {
                        Spacer()
                        HStack {
                            Text(action)
                                .font(.system(size: 11))
                                .foregroundColor(.white)
                                .padding(.horizontal, 8)
                                .padding(.vertical, 4)
                                .background(Color.black.opacity(0.75))
                                .cornerRadius(4)
                            Spacer()
                        }
                        .padding(8)
                    }
                    .transition(.opacity)
                    .animation(.easeInOut(duration: 0.2), value: manager.actionText)
                }
            }
            .animation(.easeInOut(duration: 0.2), value: manager.actionText)
        }
    }

    private func scaleHighlight(_ highlight: BrowserHighlight, viewSize: CGSize, frameSize: CGSize) -> CGRect {
        let scaleX = viewSize.width / frameSize.width
        let scaleY = viewSize.height / frameSize.height
        let scale = min(scaleX, scaleY)
        let offsetX = (viewSize.width - frameSize.width * scale) / 2
        let offsetY = (viewSize.height - frameSize.height * scale) / 2
        return CGRect(
            x: offsetX + highlight.x * scale,
            y: offsetY + highlight.y * scale,
            width: highlight.w * scale,
            height: highlight.h * scale
        )
    }

    private var statusColor: Color {
        switch manager.status {
        case "navigating": return .yellow
        case "interacting": return .blue
        default: return .green
        }
    }
}
