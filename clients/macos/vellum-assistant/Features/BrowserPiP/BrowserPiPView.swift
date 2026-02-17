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
                Text(manager.activePage?.url ?? manager.currentUrl)
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

            // Tab bar (only shown when multiple pages)
            if manager.pages.count > 1 {
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: 2) {
                        ForEach(manager.pages) { page in
                            BrowserTabView(page: page)
                        }
                    }
                    .padding(.horizontal, 4)
                    .padding(.vertical, 2)
                }
                .background(Color(NSColor.controlBackgroundColor))
                Divider()
            }

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

struct BrowserTabView: View {
    let page: BrowserPage

    var body: some View {
        HStack(spacing: 4) {
            Circle()
                .fill(page.active ? Color.accentColor : Color.gray)
                .frame(width: 8, height: 8)
            Text(page.title.isEmpty ? domainFrom(page.url) : page.title)
                .font(.system(size: 10))
                .lineLimit(1)
                .frame(maxWidth: 120)
        }
        .padding(.horizontal, 8)
        .padding(.vertical, 4)
        .background(page.active ? Color(NSColor.selectedContentBackgroundColor).opacity(0.3) : Color.clear)
        .cornerRadius(4)
    }

    private func domainFrom(_ url: String) -> String {
        guard let components = URLComponents(string: url),
              let host = components.host else { return url }
        return host
    }
}
