import SwiftUI
import AppKit
import VellumAssistantShared
import os

private let log = Logger(subsystem: Bundle.main.bundleIdentifier ?? "com.vellum.vellum-assistant", category: "BrowserPiPManager")

@MainActor
final class BrowserPiPManager: ObservableObject {
    @Published var isVisible: Bool = false
    @Published var currentUrl: String = ""
    @Published var status: String = "idle"
    @Published var actionText: String?
    @Published var currentFrame: NSImage?
    @Published var pages: [BrowserPage] = []

    private var panel: NSPanel?
    private var surfaceId: String?
    private var sessionId: String?

    private var moveObserver: Any?
    private var resizeObserver: Any?

    // Saved position
    private static let positionXKey = "BrowserPiP.positionX"
    private static let positionYKey = "BrowserPiP.positionY"
    private static let sizeWKey = "BrowserPiP.sizeW"
    private static let sizeHKey = "BrowserPiP.sizeH"

    func showPanel(for message: UiSurfaceShowMessage) {
        guard let surface = Surface.from(message),
              case .browserView(let data) = surface.data else { return }

        surfaceId = message.surfaceId
        sessionId = message.sessionId
        currentUrl = data.currentUrl
        status = data.status
        actionText = data.actionText
        pages = data.pages ?? []

        if let frameStr = data.frame {
            decodeFrame(frameStr)
        }

        if panel == nil {
            createPanel()
        }

        panel?.orderFront(nil)
        isVisible = true

        log.info("Showing browser PiP panel: surfaceId=\(message.surfaceId, privacy: .public)")
    }

    func updateSurface(_ message: UiSurfaceUpdateMessage) {
        guard message.surfaceId == surfaceId else { return }

        let dict = message.data.value as? [String: Any?] ?? [:]

        if let url = dict["currentUrl"] as? String {
            currentUrl = url
        }
        if let s = dict["status"] as? String {
            status = s
        }
        if dict.keys.contains("actionText") {
            actionText = dict["actionText"] as? String
        }
        if let frameStr = dict["frame"] as? String {
            decodeFrame(frameStr)
        }
        if let pagesArray = dict["pages"] as? [[String: Any?]] {
            pages = pagesArray.compactMap { pageDict in
                guard let id = pageDict["id"] as? String,
                      let title = pageDict["title"] as? String,
                      let url = pageDict["url"] as? String else { return nil }
                return BrowserPage(id: id, title: title, url: url, active: pageDict["active"] as? Bool ?? false)
            }
        }
    }

    func updateFrame(_ message: BrowserFrameMessage) {
        guard message.surfaceId == surfaceId else { return }
        decodeFrame(message.frame)
    }

    func dismissPanel() {
        if let moveObs = moveObserver {
            NotificationCenter.default.removeObserver(moveObs)
            moveObserver = nil
        }
        if let resizeObs = resizeObserver {
            NotificationCenter.default.removeObserver(resizeObs)
            resizeObserver = nil
        }
        panel?.close()
        panel = nil
        isVisible = false
        surfaceId = nil
        sessionId = nil
        currentFrame = nil

        log.info("Dismissed browser PiP panel")
    }

    private func decodeFrame(_ base64: String) {
        DispatchQueue.global(qos: .userInteractive).async { [weak self] in
            guard let data = Data(base64Encoded: base64),
                  let image = NSImage(data: data) else { return }
            DispatchQueue.main.async {
                self?.currentFrame = image
            }
        }
    }

    private func createPanel() {
        let view = BrowserPiPView(manager: self)
        let hostingController = NSHostingController(rootView: view)

        let panel = NSPanel(
            contentRect: savedFrame(),
            styleMask: [.titled, .closable, .resizable, .nonactivatingPanel, .utilityWindow],
            backing: .buffered,
            defer: false
        )
        panel.contentViewController = hostingController
        panel.level = .floating
        panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
        panel.title = "Browser"
        panel.isReleasedWhenClosed = false
        panel.minSize = NSSize(width: 200, height: 150)
        panel.aspectRatio = NSSize(width: 4, height: 3)

        // Position bottom-right by default
        if !hasSavedPosition() {
            positionBottomRight(panel)
        }

        // Save position on move
        moveObserver = NotificationCenter.default.addObserver(
            forName: NSWindow.didMoveNotification,
            object: panel,
            queue: .main
        ) { [weak self] _ in
            self?.savePosition()
        }
        resizeObserver = NotificationCenter.default.addObserver(
            forName: NSWindow.didResizeNotification,
            object: panel,
            queue: .main
        ) { [weak self] _ in
            self?.savePosition()
        }

        self.panel = panel
    }

    private func positionBottomRight(_ panel: NSPanel) {
        guard let screen = NSScreen.main else { return }
        let padding: CGFloat = 20
        let frame = panel.frame
        let x = screen.visibleFrame.maxX - frame.width - padding
        let y = screen.visibleFrame.minY + padding
        panel.setFrameOrigin(NSPoint(x: x, y: y))
    }

    private func savedFrame() -> NSRect {
        let defaults = UserDefaults.standard
        if defaults.object(forKey: Self.sizeWKey) != nil {
            return NSRect(
                x: defaults.double(forKey: Self.positionXKey),
                y: defaults.double(forKey: Self.positionYKey),
                width: max(defaults.double(forKey: Self.sizeWKey), 200),
                height: max(defaults.double(forKey: Self.sizeHKey), 150)
            )
        }
        return NSRect(x: 0, y: 0, width: 400, height: 300)
    }

    private func hasSavedPosition() -> Bool {
        UserDefaults.standard.object(forKey: Self.positionXKey) != nil
    }

    private func savePosition() {
        guard let frame = panel?.frame else { return }
        let defaults = UserDefaults.standard
        defaults.set(frame.origin.x, forKey: Self.positionXKey)
        defaults.set(frame.origin.y, forKey: Self.positionYKey)
        defaults.set(frame.size.width, forKey: Self.sizeWKey)
        defaults.set(frame.size.height, forKey: Self.sizeHKey)
    }
}
