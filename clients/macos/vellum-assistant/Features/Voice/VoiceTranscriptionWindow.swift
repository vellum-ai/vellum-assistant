import AppKit
import Combine
import SwiftUI

final class VoiceTranscriptionViewModel: ObservableObject {
    @Published var transcriptionText: String = ""
    @Published var contentHeight: CGFloat = 0
    @Published var isOverflowing: Bool = false


}

private struct TextHeightPreferenceKey: PreferenceKey {
    static var defaultValue: CGFloat = 0
    static func reduce(value: inout CGFloat, nextValue: () -> CGFloat) {
        value = nextValue()
    }
}

struct VoiceTranscriptionView: View {
    @ObservedObject var viewModel: VoiceTranscriptionViewModel

    private let lineHeight: CGFloat = 20
    private let maxLines: Int = 4
    private let fadeHeight: CGFloat = 20

    private var maxTextHeight: CGFloat { CGFloat(maxLines) * lineHeight }

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(alignment: .top, spacing: 10) {
                Image(systemName: "mic.fill")
                    .foregroundColor(VColor.error)
                    .font(.system(size: 18))
                    .padding(.top, 2)

                if viewModel.transcriptionText.isEmpty {
                    Text("Listening...")
                        .foregroundColor(.secondary)
                        .font(.system(size: 14))
                        .frame(maxWidth: .infinity, alignment: .leading)
                } else {
                    ScrollViewReader { proxy in
                        ScrollView(.vertical, showsIndicators: false) {
                            Text(viewModel.transcriptionText)
                                .foregroundColor(.primary)
                                .font(.system(size: 14))
                                .fixedSize(horizontal: false, vertical: true)
                                .frame(maxWidth: .infinity, alignment: .leading)
                                .background(
                                    GeometryReader { geometry in
                                        Color.clear
                                            .preference(key: TextHeightPreferenceKey.self, value: geometry.size.height)
                                    }
                                )
                                .id("bottom")
                        }
                        .frame(height: min(viewModel.contentHeight, maxTextHeight))
                        .mask(fadeMask)
                        .onPreferenceChange(TextHeightPreferenceKey.self) { height in
                            viewModel.contentHeight = height
                            viewModel.isOverflowing = height > maxTextHeight
                        }
                        .onChange(of: viewModel.transcriptionText) {
                            proxy.scrollTo("bottom", anchor: .bottom)
                        }
                    }
                }
            }

        }
        .padding(.horizontal, 16)
        .padding(.vertical, 12)
        .frame(width: 320)
        .onChange(of: viewModel.transcriptionText) {
            if viewModel.transcriptionText.isEmpty {
                viewModel.contentHeight = 0
                viewModel.isOverflowing = false
            }
        }
    }

    @ViewBuilder
    private var fadeMask: some View {
        if viewModel.isOverflowing {
            VStack(spacing: 0) {
                LinearGradient(
                    gradient: Gradient(colors: [.clear, .black]),
                    startPoint: .top,
                    endPoint: .bottom
                )
                .frame(height: fadeHeight)

                Color.black
            }
        } else {
            Color.black
        }
    }
}

@MainActor
final class VoiceTranscriptionWindow {
    private var panel: NSPanel?
    private let viewModel = VoiceTranscriptionViewModel()
    private var heightCancellable: AnyCancellable?

    private let panelWidth: CGFloat = 320
    private let basePadding: CGFloat = 24 // vertical padding (12 top + 12 bottom)
    private var bottomY: CGFloat = 0 // fixed bottom edge for upward growth

    func show() {
        let hostingController = NSHostingController(rootView: VoiceTranscriptionView(viewModel: viewModel))

        let initialHeight: CGFloat = basePadding + 22 // mic icon / single text line

        let panel = NSPanel(
            contentRect: NSRect(x: 0, y: 0, width: panelWidth, height: initialHeight),
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

        // Position center-bottom of screen (above dock), anchored at bottom edge
        if let screen = NSScreen.main {
            let screenFrame = screen.visibleFrame
            let x = screenFrame.midX - panelWidth / 2
            bottomY = screenFrame.minY + 20
            let frame = NSRect(x: x, y: bottomY, width: panelWidth, height: initialHeight)
            panel.setFrame(frame, display: false)
        }

        panel.orderFront(nil)
        self.panel = panel

        // Subscribe to content height changes to resize the panel
        heightCancellable = viewModel.$contentHeight
            .combineLatest(viewModel.$transcriptionText)
            .receive(on: RunLoop.main)
            .sink { [weak self] contentHeight, text in
                self?.resizePanel(textContentHeight: contentHeight, hasText: !text.isEmpty)
            }
    }

    func updateText(_ text: String) {
        viewModel.transcriptionText = text
    }

    func close() {
        heightCancellable?.cancel()
        heightCancellable = nil
        panel?.close()
        panel = nil
    }

    private func resizePanel(textContentHeight: CGFloat, hasText: Bool) {
        guard let panel = panel else { return }

        let contentAreaHeight: CGFloat
        if hasText {
            let lineHeight: CGFloat = 20
            let maxTextHeight = lineHeight * 4
            contentAreaHeight = max(22, min(textContentHeight, maxTextHeight))
        } else {
            contentAreaHeight = 22 // mic icon height only
        }

        let totalHeight = basePadding + contentAreaHeight

        // Grow upward from fixed bottom edge
        let newFrame = NSRect(x: panel.frame.origin.x, y: bottomY, width: panelWidth, height: totalHeight)
        panel.setFrame(newFrame, display: true, animate: true)
    }
}
