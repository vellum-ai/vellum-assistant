import AppKit
import SwiftUI
import HotKey

@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate {
    private var statusItem: NSStatusItem!
    private var popover: NSPopover!
    private var hotKey: HotKey?
    private var escapeMonitor: Any?
    private var overlayWindow: SessionOverlayWindow?
    var currentSession: ComputerUseSession?
    private var voiceInput: VoiceInputManager?

    private var windowObserver: Any?

    func applicationDidFinishLaunching(_ notification: Notification) {
        setupMenuBar()
        setupHotKey()
        setupEscapeMonitor()
        setupVoiceInput()

        // Watch for Settings window closing to revert to accessory activation policy
        windowObserver = NotificationCenter.default.addObserver(
            forName: NSWindow.willCloseNotification, object: nil, queue: .main
        ) { [weak self] notification in
            guard let window = notification.object as? NSWindow,
                  window.title.contains("Settings") || window.title.contains("vellum") else { return }
            // Revert to accessory (no dock icon) after settings closes
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.2) {
                let hasVisibleWindows = NSApp.windows.contains { $0.isVisible && $0 !== self?.statusItem.button?.window }
                if !hasVisibleWindows {
                    NSApp.setActivationPolicy(.accessory)
                }
            }
        }
    }

    // MARK: - Menu Bar

    private func setupMenuBar() {
        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.squareLength)
        if let button = statusItem.button {
            button.image = NSImage(systemSymbolName: "sparkles", accessibilityDescription: "vellum-assistant")
            button.sendAction(on: [.leftMouseUp, .rightMouseUp])
            button.action = #selector(statusBarButtonClicked(_:))
            button.target = self
        }

        let contentView = TaskInputView(onSubmit: { [weak self] task in
            self?.startSession(task: task)
        })

        popover = NSPopover()
        popover.contentSize = NSSize(width: 320, height: 200)
        popover.behavior = .transient
        popover.contentViewController = NSHostingController(rootView: contentView)
    }

    @objc private func statusBarButtonClicked(_ sender: NSStatusBarButton) {
        guard let event = NSApp.currentEvent else { return }
        if event.type == .rightMouseUp {
            showContextMenu()
        } else {
            togglePopover()
        }
    }

    private func showContextMenu() {
        guard let button = statusItem.button else { return }
        let menu = NSMenu()
        menu.addItem(NSMenuItem(title: "Quit", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q"))
        menu.popUp(positioning: nil, at: NSPoint(x: 0, y: 0), in: button)
    }

    // MARK: - Hotkey

    private func setupHotKey() {
        hotKey = HotKey(key: .g, modifiers: [.command, .shift])
        hotKey?.keyDownHandler = { [weak self] in
            self?.togglePopover()
        }
    }

    private func setupEscapeMonitor() {
        escapeMonitor = NSEvent.addGlobalMonitorForEvents(matching: .keyDown) { [weak self] event in
            if event.keyCode == 53 { // Escape
                Task { @MainActor in
                    self?.currentSession?.cancel()
                }
            }
        }
    }

    // MARK: - Voice Input

    private func setupVoiceInput() {
        voiceInput = VoiceInputManager()
        voiceInput?.onTranscription = { [weak self] text in
            self?.startSession(task: text)
        }
        voiceInput?.onRecordingStateChanged = { [weak self] isRecording in
            self?.statusItem.button?.image = NSImage(
                systemSymbolName: isRecording ? "mic.fill" : "sparkles",
                accessibilityDescription: "vellum-assistant"
            )
        }
        voiceInput?.start()
    }

    // MARK: - Popover

    private func togglePopover() {
        guard let button = statusItem.button else { return }
        if popover.isShown {
            popover.performClose(nil)
        } else {
            popover.show(relativeTo: button.bounds, of: button, preferredEdge: .minY)
            NSApp.activate(ignoringOtherApps: true)
        }
    }

    // MARK: - Session

    func startSession(task: String) {
        guard currentSession == nil else { return }
        popover.performClose(nil)

        guard let apiKey = APIKeyManager.getKey() else {
            NSApp.sendAction(Selector(("showSettingsWindow:")), to: nil, from: nil)
            return
        }

        guard ActionExecutor.checkAccessibilityPermission(prompt: true) else {
            return
        }

        let provider = AnthropicProvider(apiKey: apiKey)
        let storedMaxSteps = UserDefaults.standard.double(forKey: "maxStepsPerSession")
        let maxSteps = storedMaxSteps > 0 ? Int(storedMaxSteps) : 50
        let session = ComputerUseSession(task: task, provider: provider, maxSteps: maxSteps)
        currentSession = session

        let overlay = SessionOverlayWindow(session: session)
        overlay.show()
        overlayWindow = overlay

        Task { @MainActor in
            await session.run()
            try? await Task.sleep(nanoseconds: 3_000_000_000)
            overlay.close()
            self.overlayWindow = nil
            self.currentSession = nil
        }
    }

    func applicationWillTerminate(_ notification: Notification) {
        if let monitor = escapeMonitor {
            NSEvent.removeMonitor(monitor)
        }
        voiceInput?.stop()
    }
}
