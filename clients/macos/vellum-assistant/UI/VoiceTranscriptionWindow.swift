import AppKit
import SwiftUI

final class VoiceTranscriptionViewModel: ObservableObject {
    @Published var transcriptionText: String = ""
}

struct VoiceTranscriptionView: View {
    @ObservedObject var viewModel: VoiceTranscriptionViewModel

    var body: some View {
        HStack(spacing: 10) {
            Image(systemName: "mic.fill")
                .foregroundColor(.red)
                .font(.system(size: 18))

            Text(viewModel.transcriptionText.isEmpty ? "Listening..." : viewModel.transcriptionText)
                .foregroundColor(viewModel.transcriptionText.isEmpty ? .secondary : .primary)
                .font(.system(size: 14))
                .lineLimit(2)
                .frame(maxWidth: .infinity, alignment: .leading)
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 12)
        .frame(width: 320)
    }
}

@MainActor
final class VoiceTranscriptionWindow {
    private var panel: NSPanel?
    private let viewModel = VoiceTranscriptionViewModel()

    func show() {
        let hostingController = NSHostingController(rootView: VoiceTranscriptionView(viewModel: viewModel))

        let panel = NSPanel(
            contentRect: NSRect(x: 0, y: 0, width: 320, height: 56),
            styleMask: [.titled, .nonactivatingPanel, .utilityWindow, .hudWindow],
            backing: .buffered,
            defer: false
        )

        panel.contentViewController = hostingController
        panel.level = .floating
        panel.titleVisibility = .hidden
        panel.titlebarAppearsTransparent = true
        panel.alphaValue = 0.9
        panel.isReleasedWhenClosed = false
        panel.collectionBehavior = [.canJoinAllSpaces, .stationary]

        // Position center-bottom of screen (above dock)
        if let screen = NSScreen.main {
            let screenFrame = screen.visibleFrame
            let x = screenFrame.midX - 160
            let y = screenFrame.minY + 20
            panel.setFrameOrigin(NSPoint(x: x, y: y))
        }

        panel.orderFront(nil)
        self.panel = panel
    }

    func updateText(_ text: String) {
        viewModel.transcriptionText = text
    }

    func close() {
        panel?.close()
        panel = nil
    }
}
