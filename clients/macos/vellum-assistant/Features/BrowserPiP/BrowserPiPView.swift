import SwiftUI

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
                }
            }
        }
    }

    private var statusColor: Color {
        switch manager.status {
        case "navigating": return .yellow
        case "interacting": return .blue
        default: return .green
        }
    }
}
