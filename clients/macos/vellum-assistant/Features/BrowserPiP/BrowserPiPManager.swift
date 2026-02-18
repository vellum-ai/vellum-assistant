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
    @Published var highlights: [BrowserHighlight] = []
    @Published var isInteractive: Bool = false
    var handoffMessage: String?
    var frameSize: CGSize = CGSize(width: 1280, height: 960)

    var activePage: BrowserPage? {
        pages.first(where: { $0.active })
    }

    private var panel: NSPanel?
    private var actionTextClearTask: Task<Void, Never>?
    private var surfaceId: String?
    private var sessionId: String?

    private var moveObserver: Any?
    private var resizeObserver: Any?
    private let decodeQueue = DispatchQueue(label: "browser-pip-frame-decode")
    weak var daemonClient: DaemonClient?

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
            scheduleActionTextClear()
        }
        if let frameStr = dict["frame"] as? String {
            decodeFrame(frameStr)
        }
        if dict.keys.contains("highlights") {
            if let highlightsArray = dict["highlights"] as? [[String: Any?]] {
                highlights = highlightsArray.compactMap { item in
                    guard let x = item["x"] as? Double,
                          let y = item["y"] as? Double,
                          let w = item["w"] as? Double,
                          let h = item["h"] as? Double,
                          let label = item["label"] as? String else { return nil }
                    return BrowserHighlight(x: x, y: y, w: w, h: h, label: label)
                }
            } else {
                highlights = []
            }
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


    func toggleInteractiveMode() {
        guard let sessionId, let surfaceId else { return }
        isInteractive.toggle()
        try? daemonClient?.send(BrowserInteractiveModeMessage(sessionId: sessionId, surfaceId: surfaceId, enabled: isInteractive))
    }

    func sendUserClick(viewX: CGFloat, viewY: CGFloat, viewSize: CGSize, button: String? = nil, doubleClick: Bool? = nil) {
        guard let sessionId, let surfaceId, isInteractive else { return }
        let (scX, scY) = viewToScreencast(viewX: viewX, viewY: viewY, viewSize: viewSize)
        try? daemonClient?.send(BrowserUserClickMessage(sessionId: sessionId, surfaceId: surfaceId, x: scX, y: scY, button: button, doubleClick: doubleClick))
    }

    func sendUserScroll(deltaX: CGFloat, deltaY: CGFloat, viewX: CGFloat, viewY: CGFloat, viewSize: CGSize) {
        guard let sessionId, let surfaceId, isInteractive else { return }
        let (scX, scY) = viewToScreencast(viewX: viewX, viewY: viewY, viewSize: viewSize)
        try? daemonClient?.send(BrowserUserScrollMessage(sessionId: sessionId, surfaceId: surfaceId, deltaX: Double(deltaX), deltaY: Double(deltaY), x: scX, y: scY))
    }

    func sendUserKeypress(key: String, modifiers: [String]? = nil) {
        guard let sessionId, let surfaceId, isInteractive else { return }
        try? daemonClient?.send(BrowserUserKeypressMessage(sessionId: sessionId, surfaceId: surfaceId, key: key, modifiers: modifiers))
    }

    func handleInteractiveModeChanged(_ message: BrowserInteractiveModeChangedMessage) {
        guard message.surfaceId == surfaceId else { return }
        isInteractive = message.enabled
        handoffMessage = message.enabled ? message.message : nil
    }

    /// Convert PiP view coordinates to screencast coordinates.
    /// This is the inverse of `scaleHighlight()` in BrowserPiPView.
    private func viewToScreencast(viewX: CGFloat, viewY: CGFloat, viewSize: CGSize) -> (Double, Double) {
        let scaleX = viewSize.width / frameSize.width
        let scaleY = viewSize.height / frameSize.height
        let scale = min(scaleX, scaleY)
        let offsetX = (viewSize.width - frameSize.width * scale) / 2
        let offsetY = (viewSize.height - frameSize.height * scale) / 2
        let scX = (viewX - offsetX) / scale
        let scY = (viewY - offsetY) / scale
        return (Double(scX), Double(scY))
    }

    func dismissIfMatching(surfaceId: String) {
        guard surfaceId == self.surfaceId else { return }
        dismissPanel()
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
        isInteractive = false
        handoffMessage = nil

        log.info("Dismissed browser PiP panel")
    }

    private func decodeFrame(_ base64: String) {
        decodeQueue.async { [weak self] in
            guard let data = Data(base64Encoded: base64),
                  let image = NSImage(data: data) else { return }
            DispatchQueue.main.async {
                self?.currentFrame = image
                if image.size.width > 0 && image.size.height > 0 {
                    self?.frameSize = image.size
                }
            }
        }
    }

    private func scheduleActionTextClear() {
        actionTextClearTask?.cancel()
        guard actionText != nil else { return }
        actionTextClearTask = Task { @MainActor in
            try? await Task.sleep(nanoseconds: 3_000_000_000)
            guard !Task.isCancelled else { return }
            self.actionText = nil
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
            Task { @MainActor in self?.savePosition() }
        }
        resizeObserver = NotificationCenter.default.addObserver(
            forName: NSWindow.didResizeNotification,
            object: panel,
            queue: .main
        ) { [weak self] _ in
            Task { @MainActor in self?.savePosition() }
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
        return NSRect(x: 0, y: 0, width: 800, height: 600)
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
