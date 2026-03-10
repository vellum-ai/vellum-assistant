import AppKit
import Carbon
import Combine
import VellumAssistantShared
import os

private let log = Logger(subsystem: Bundle.main.bundleIdentifier ?? "com.vellum.vellum-assistant", category: "AppDelegate")

/// Carbon event handler for the Quick Input hotkey (Cmd+Shift+/).
/// Must be a free function because Carbon callbacks are C function pointers.
func quickInputHotKeyHandler(
    _: EventHandlerCallRef?,
    event: EventRef?,
    _: UnsafeMutableRawPointer?
) -> OSStatus {
    guard let event else { return OSStatus(eventNotHandledErr) }

    var hotKeyID = EventHotKeyID()
    let status = GetEventParameter(
        event,
        EventParamName(kEventParamDirectObject),
        EventParamType(typeEventHotKeyID),
        nil,
        MemoryLayout<EventHotKeyID>.size,
        nil,
        &hotKeyID
    )
    guard status == noErr, hotKeyID.id == 1 else { return OSStatus(eventNotHandledErr) }

    Task { @MainActor in
        guard let appDelegate = AppDelegate.shared,
              !appDelegate.isBootstrapping else { return }
        appDelegate.toggleQuickInput()
    }
    return noErr
}

// KVO-observable UserDefaults properties for scoped hotkey settings observation.
// Using @objc dynamic enables Combine's publisher(for:) key-path KVO without
// listening to every UserDefaults write app-wide.
extension UserDefaults {
    @objc dynamic var globalHotkeyShortcut: String {
        if UserDefaults.standard.object(forKey: "globalHotkeyShortcut") == nil {
            return "cmd+shift+g"
        }
        return string(forKey: "globalHotkeyShortcut") ?? ""
    }
    @objc dynamic var quickInputHotkeyShortcut: String {
        if UserDefaults.standard.object(forKey: "quickInputHotkeyShortcut") == nil {
            return "cmd+shift+/"
        }
        return string(forKey: "quickInputHotkeyShortcut") ?? ""
    }
    @objc dynamic var quickInputHotkeyKeyCode: Int {
        return integer(forKey: "quickInputHotkeyKeyCode")
    }
}

// MARK: - Input Monitors

extension AppDelegate {

    func setupHotKey() {
        guard !hasSetupHotKey else { return }
        hasSetupHotKey = true

        registerGlobalHotkeyMonitor()
        registerQuickInputMonitor()
        registerFnVMonitor()
        registerCmdKMonitor()

        globalHotkeyObserver = Publishers.Merge3(
            UserDefaults.standard.publisher(for: \.globalHotkeyShortcut).map { _ in () },
            UserDefaults.standard.publisher(for: \.quickInputHotkeyShortcut).map { _ in () },
            UserDefaults.standard.publisher(for: \.quickInputHotkeyKeyCode).map { _ in () }
        )
        .debounce(for: .milliseconds(100), scheduler: RunLoop.main)
        .sink { [weak self] _ in
            self?.registerGlobalHotkeyMonitor()
            self?.registerQuickInputMonitor()
        }
    }

    /// Registers a Carbon hotkey for Quick Input that intercepts system-wide,
    /// before the frontmost app's menu system can consume it.
    /// Reads the shortcut and key code from UserDefaults. Skips re-registration if unchanged.
    func registerQuickInputMonitor() {
        let shortcut = UserDefaults.standard.string(forKey: "quickInputHotkeyShortcut") ?? "cmd+shift+/"

        if shortcut == lastRegisteredQuickInputHotkey { return }

        // Tear down previous registration
        if let ref = quickInputHotKeyRef {
            UnregisterEventHotKey(ref)
            quickInputHotKeyRef = nil
        }
        if let ref = quickInputEventHandlerRef {
            RemoveEventHandler(ref)
            quickInputEventHandlerRef = nil
        }

        guard !shortcut.isEmpty else {
            lastRegisteredQuickInputHotkey = shortcut
            log.info("Quick Input: hotkey disabled")
            return
        }

        let storedKeyCode = UserDefaults.standard.object(forKey: "quickInputHotkeyKeyCode") as? Int
        let keyCode = UInt32(storedKeyCode ?? Int(kVK_ANSI_Slash))
        let (modifierFlags, _) = ShortcutHelper.parseShortcut(shortcut)
        let carbonMods = ShortcutHelper.carbonModifiers(from: modifierFlags)

        // Install Carbon event handler for hotkey events
        var eventType = EventTypeSpec(eventClass: OSType(kEventClassKeyboard), eventKind: UInt32(kEventHotKeyPressed))
        var handlerRef: EventHandlerRef?
        InstallEventHandler(GetApplicationEventTarget(), quickInputHotKeyHandler, 1, &eventType, nil, &handlerRef)
        quickInputEventHandlerRef = handlerRef

        let hotKeyID = EventHotKeyID(signature: OSType(0x564C_4D51), id: 1) // "VLMQ"
        var hotKeyRef: EventHotKeyRef?
        let status = RegisterEventHotKey(
            keyCode,
            carbonMods,
            hotKeyID,
            GetApplicationEventTarget(),
            0,
            &hotKeyRef
        )
        if status == noErr {
            quickInputHotKeyRef = hotKeyRef
            log.info("Quick Input: Carbon hotkey \(ShortcutHelper.displayString(for: shortcut)) registered successfully")
        } else {
            log.error("Quick Input: Failed to register Carbon hotkey, status: \(status)")
        }

        lastRegisteredQuickInputHotkey = shortcut
    }

    /// Removes the Carbon hotkey and event handler registrations,
    /// plus the Cmd+K local monitor.
    func tearDownQuickInputMonitors() {
        if let ref = quickInputHotKeyRef {
            UnregisterEventHotKey(ref)
            quickInputHotKeyRef = nil
        }
        if let ref = quickInputEventHandlerRef {
            RemoveEventHandler(ref)
            quickInputEventHandlerRef = nil
        }
        if let monitor = fnVGlobalMonitor {
            NSEvent.removeMonitor(monitor)
            fnVGlobalMonitor = nil
        }
        if let monitor = fnVLocalMonitor {
            NSEvent.removeMonitor(monitor)
            fnVLocalMonitor = nil
        }
        if let monitor = cmdKLocalMonitor {
            NSEvent.removeMonitor(monitor)
            cmdKLocalMonitor = nil
        }
        if let monitor = navLocalMonitor {
            NSEvent.removeMonitor(monitor)
            navLocalMonitor = nil
        }
        if let monitor = zoomLocalMonitor {
            NSEvent.removeMonitor(monitor)
            zoomLocalMonitor = nil
        }
    }

    /// Registers Cmd+Shift+V as a global shortcut to open the quick input text field.
    /// Uses NSEvent monitors (global + local).
    func registerFnVMonitor() {
        let handler: (NSEvent) -> NSEvent? = { [weak self] event in
            // Cmd+Shift+V: keyCode 9 is kVK_ANSI_V
            let mods = event.modifierFlags.intersection(.deviceIndependentFlagsMask)
            guard event.keyCode == 9,
                  mods == [.command, .shift] else {
                return event
            }
            Task { @MainActor in
                guard self?.isBootstrapping != true else { return }
                self?.toggleQuickInput(aboveDock: true)
            }
            return nil // consume the event
        }

        fnVGlobalMonitor = NSEvent.addGlobalMonitorForEvents(matching: .keyDown) { event in
            _ = handler(event)
        }
        fnVLocalMonitor = NSEvent.addLocalMonitorForEvents(matching: .keyDown, handler: handler)
    }

    /// Registers Cmd+K as a local shortcut to open the command palette.
    /// Only active when the app is focused (local monitor, not global).
    func registerCmdKMonitor() {
        let handler: (NSEvent) -> NSEvent? = { [weak self] event in
            // Cmd+K: keyCode 40 is kVK_ANSI_K
            let mods = event.modifierFlags.intersection(.deviceIndependentFlagsMask)
            guard event.keyCode == 40,
                  mods == [.command] else {
                return event
            }
            Task { @MainActor in
                guard self?.isBootstrapping != true else { return }
                self?.toggleCommandPalette()
            }
            return nil // consume the event
        }
        cmdKLocalMonitor = NSEvent.addLocalMonitorForEvents(matching: .keyDown, handler: handler)
    }

    /// Registers Cmd+[ and Cmd+] as local shortcuts for back/forward navigation.
    /// Uses event monitoring (like Cmd+K) instead of NSMenu key equivalents
    /// because SwiftUI manages the menu bar and may interfere with programmatic
    /// NSMenu items and their validation.
    ///
    /// Matches on `charactersIgnoringModifiers` instead of hardware keycodes
    /// so the shortcuts work correctly on non-ANSI keyboard layouts (ISO, JIS).
    /// Only consumes the event when navigation actually occurs — if the history
    /// stack is empty, the event passes through to the responder chain.
    func registerNavigationMonitor() {
        guard navLocalMonitor == nil else { return }
        let handler: (NSEvent) -> NSEvent? = { [weak self] event in
            let mods = event.modifierFlags.intersection(.deviceIndependentFlagsMask)
            guard mods == [.command] else { return event }
            guard let chars = event.charactersIgnoringModifiers else { return event }
            switch chars {
            case "[":
                guard self?.mainWindow?.windowState.navigationHistory.canGoBack == true else { return event }
                Task { @MainActor in
                    self?.mainWindow?.windowState.navigateBack()
                }
                return nil
            case "]":
                guard self?.mainWindow?.windowState.navigationHistory.canGoForward == true else { return event }
                Task { @MainActor in
                    self?.mainWindow?.windowState.navigateForward()
                }
                return nil
            default:
                return event
            }
        }
        navLocalMonitor = NSEvent.addLocalMonitorForEvents(matching: .keyDown, handler: handler)
    }

    /// Registers Cmd+=/Cmd+-/Cmd+0 as local shortcuts for window zoom.
    /// Uses event monitoring instead of NSMenu key equivalents because
    /// SwiftUI manages the menu bar and strips programmatic items.
    func registerZoomMonitor() {
        guard zoomLocalMonitor == nil else { return }
        let handler: (NSEvent) -> NSEvent? = { [weak self] event in
            let mods = event.modifierFlags.intersection(.deviceIndependentFlagsMask)
            guard let chars = event.charactersIgnoringModifiers else { return event }
            // Cmd+= (same physical key as Cmd++, shift ignored)
            if chars == "=" && mods.contains(.command) && !mods.contains(.control) {
                Task { @MainActor in self?.zoomManager.zoomIn() }
                return nil
            }
            // Cmd+-
            if chars == "-" && mods == [.command] {
                Task { @MainActor in self?.zoomManager.zoomOut() }
                return nil
            }
            // Cmd+0
            if chars == "0" && mods == [.command] {
                Task { @MainActor in self?.zoomManager.resetZoom() }
                return nil
            }
            return event
        }
        zoomLocalMonitor = NSEvent.addLocalMonitorForEvents(matching: .keyDown, handler: handler)
    }

    func toggleCommandPalette() {
        if let window = commandPaletteWindow, window.isVisible {
            window.dismiss()
            return
        }

        let window = CommandPaletteWindow()

        // Static actions
        window.actions = [
            CommandPaletteAction(id: "new-conversation", icon: VIcon.squarePen.rawValue, label: "New Conversation", shortcutHint: "\u{2318}N") { [weak self] in
                self?.mainWindow?.threadManager.createThread()
                if let id = self?.mainWindow?.threadManager.activeThreadId {
                    self?.mainWindow?.windowState.selection = .thread(id)
                }
            },
            CommandPaletteAction(id: "settings", icon: VIcon.settings.rawValue, label: "Settings", shortcutHint: "\u{2318},") { [weak self] in
                self?.mainWindow?.windowState.togglePanel(.settings)
            },
            CommandPaletteAction(id: "app-directory", icon: VIcon.layoutGrid.rawValue, label: "Things", shortcutHint: nil) { [weak self] in
                self?.mainWindow?.windowState.showAppsPanel()
            },
            CommandPaletteAction(id: "intelligence", icon: VIcon.brain.rawValue, label: "Intelligence", shortcutHint: nil) { [weak self] in
                self?.mainWindow?.windowState.togglePanel(.intelligence)
            },
            CommandPaletteAction(id: "navigate-back", icon: VIcon.chevronLeft.rawValue, label: "Back", shortcutHint: "\u{2318}[") { [weak self] in
                self?.mainWindow?.windowState.navigateBack()
            },
            CommandPaletteAction(id: "navigate-forward", icon: VIcon.chevronRight.rawValue, label: "Forward", shortcutHint: "\u{2318}]") { [weak self] in
                self?.mainWindow?.windowState.navigateForward()
            },
            CommandPaletteAction(id: "zoom-in", icon: VIcon.zoomIn.rawValue, label: "Zoom In", shortcutHint: "\u{2318}+") { [weak self] in
                self?.zoomManager.zoomIn()
            },
            CommandPaletteAction(id: "zoom-out", icon: VIcon.zoomOut.rawValue, label: "Zoom Out", shortcutHint: "\u{2318}-") { [weak self] in
                self?.zoomManager.zoomOut()
            },
            CommandPaletteAction(id: "zoom-reset", icon: VIcon.search.rawValue, label: "Actual Size", shortcutHint: "\u{2318}0") { [weak self] in
                self?.zoomManager.resetZoom()
            },
        ]

        // Recent conversations from ThreadManager
        if let threads = mainWindow?.threadManager.threads {
            window.recentItems = threads
                .filter { !$0.isArchived }
                .sorted { $0.lastInteractedAt > $1.lastInteractedAt }
                .prefix(5)
                .map { CommandPaletteRecentItem(id: $0.id, title: $0.title, lastInteracted: $0.lastInteractedAt) }
        }

        window.onSelectConversation = { [weak self] threadId in
            self?.mainWindow?.threadManager.selectThread(id: threadId)
        }

        // Wire runtime HTTP resolver for server search
        window.runtimeHTTPResolver = {
            let port = ProcessInfo.processInfo.environment["RUNTIME_HTTP_PORT"]
                .flatMap(Int.init) ?? 7821
            guard let jwt = ActorTokenManager.getToken(), !jwt.isEmpty else { return nil }
            return ("http://localhost:\(port)", jwt)
        }

        window.show()
        commandPaletteWindow = window
    }

    func toggleQuickInput(aboveDock: Bool = false, requestScreenPermission: Bool? = nil) {
        if let window = quickInputWindow, window.isVisible {
            window.dismiss()
            return
        }

        // Auto-detect screen recording permission if not explicitly specified
        let shouldShowPermissionPrompt = requestScreenPermission
            ?? (PermissionManager.screenRecordingStatus() != .granted)

        let window = QuickInputWindow()
        window.onSubmit = { [weak self, weak window] message, imageData in
            let notify = window?.notifyOnComplete ?? false
            self?.handleQuickInputSubmit(message, imageData: imageData, notifyOnComplete: notify)
        }
        window.onSubmitToThread = { [weak self, weak window] message, imageData in
            let notify = window?.notifyOnComplete ?? false
            self?.handleQuickInputSubmitToThread(message, imageData: imageData, notifyOnComplete: notify)
        }
        window.onSelectThread = { [weak self] threadId in
            self?.handleQuickInputSelectThread(threadId)
        }
        window.onMicrophoneToggle = { [weak self] in
            self?.voiceInput?.toggleRecording()
        }
        // Provide the 3 most recent non-archived threads
        if let threads = mainWindow?.threadManager.threads {
            window.recentThreads = threads
                .filter { !$0.isArchived }
                .sorted { $0.lastInteractedAt > $1.lastInteractedAt }
                .prefix(3)
                .map { QuickInputThread(id: $0.id, title: $0.title) }
        }
        window.showScreenPermissionPrompt = shouldShowPermissionPrompt
        if aboveDock {
            window.showAboveDock()
        } else {
            window.show()
        }
        quickInputWindow = window
    }

    /// Starts screen region capture directly from the menu bar icon click.
    /// After the user selects a region, the quick input bar appears near
    /// the selection with the screenshot attached.
    func startScreenCapture() {
        guard PermissionManager.screenRecordingStatus() == .granted else {
            PermissionManager.requestScreenRecordingAccess()
            return
        }

        // Dismiss any existing quick input window
        quickInputWindow?.dismiss()
        quickInputWindow = nil

        let selectionWindow = ScreenSelectionWindow()
        selectionWindow.onComplete = { [weak self] imageData, selectionRect in
            guard let self else { return }

            let window = QuickInputWindow()
            window.onSubmit = { [weak self, weak window] message, imgData in
                let notify = window?.notifyOnComplete ?? false
                self?.handleQuickInputSubmit(message, imageData: imgData, notifyOnComplete: notify)
            }
            window.onSubmitToThread = { [weak self, weak window] message, imgData in
                let notify = window?.notifyOnComplete ?? false
                self?.handleQuickInputSubmitToThread(message, imageData: imgData, notifyOnComplete: notify)
            }
            window.onSelectThread = { [weak self] threadId in
                self?.handleQuickInputSelectThread(threadId)
            }
            window.onMicrophoneToggle = { [weak self] in
                self?.voiceInput?.toggleRecording()
            }
            if let threads = self.mainWindow?.threadManager.threads {
                window.recentThreads = threads
                    .filter { !$0.isArchived }
                    .sorted { $0.lastInteractedAt > $1.lastInteractedAt }
                    .prefix(3)
                    .map { QuickInputThread(id: $0.id, title: $0.title) }
            }
            window.setAttachment(imageData: imageData)
            window.showNearRect(selectionRect)
            self.quickInputWindow = window
        }
        selectionWindow.onCancel = { /* User cancelled — do nothing */ }
        selectionWindow.show()
    }

    func handleQuickInputSubmit(_ message: String, imageData: Data?, notifyOnComplete: Bool) {
        // Ensure mainWindow exists so we can get a ChatViewModel.
        // Never show it — quick input is fire-and-forget.
        ensureMainWindowExists()
        guard let mainWindow else { return }
        mainWindow.threadManager.createThread()
        if let threadId = mainWindow.threadManager.activeThreadId {
            mainWindow.windowState.selection = .thread(threadId)
        }
        guard let viewModel = mainWindow.activeViewModel else { return }

        if notifyOnComplete {
            setupQuickInputNotification(on: viewModel)
        }

        if let imageData {
            viewModel.addAttachment(imageData: imageData, filename: "Screenshot.jpg")
            viewModel.inputText = message
            quickInputAttachmentCancellable = viewModel.attachmentManager.$isLoadingAttachment
                .filter { !$0 }
                .first()
                .sink { [weak self] _ in
                    viewModel.sendMessage()
                    self?.quickInputAttachmentCancellable = nil
                }
        } else {
            viewModel.inputText = message
            viewModel.sendMessage()
        }
    }

    func handleQuickInputSubmitToThread(_ message: String, imageData: Data?, notifyOnComplete: Bool) {
        guard let mainWindow else { return }
        if let viewModel = mainWindow.activeViewModel {
            if notifyOnComplete {
                setupQuickInputNotification(on: viewModel)
            }
            if let imageData {
                viewModel.addAttachment(imageData: imageData, filename: "Screenshot.jpg")
            }
            viewModel.inputText = message
            viewModel.sendMessage()
        }
    }

    /// Sets a one-shot `onResponseComplete` callback on the view model to send a macOS notification.
    func setupQuickInputNotification(on viewModel: ChatViewModel) {
        let notificationService = services.activityNotificationService
        viewModel.onResponseComplete = { [weak viewModel] summary in
            // One-shot — clear the callback after firing
            viewModel?.onResponseComplete = nil
            Task {
                await notificationService.notifyQuickInputComplete(summary: summary)
            }
        }
    }

    func handleQuickInputSelectThread(_ threadId: UUID) {
        showMainWindow()
        guard let mainWindow else { return }
        mainWindow.threadManager.activeThreadId = threadId
    }

    /// Tears down and re-registers the global "Open Vellum" hotkey based on
    /// the current `globalHotkeyShortcut` UserDefaults value. Skips
    /// re-registration if the shortcut hasn't changed.
    func registerGlobalHotkeyMonitor() {
        let shortcut = UserDefaults.standard.string(forKey: "globalHotkeyShortcut") ?? "cmd+shift+g"

        if shortcut == lastRegisteredGlobalHotkey { return }

        if let existing = hotKeyMonitor {
            NSEvent.removeMonitor(existing)
            hotKeyMonitor = nil
        }

        guard !shortcut.isEmpty else {
            lastRegisteredGlobalHotkey = shortcut
            log.info("Open Vellum: hotkey disabled")
            return
        }

        let (targetModifiers, targetKey) = ShortcutHelper.parseShortcut(shortcut)

        // Use NSEvent global monitor instead of Carbon RegisterEventHotKey (HotKey package).
        // Carbon hotkeys consume the event globally, preventing other apps from seeing the
        // keystroke. NSEvent.addGlobalMonitorForEvents observes without consuming.
        hotKeyMonitor = NSEvent.addGlobalMonitorForEvents(matching: .keyDown) { [weak self] event in
            let eventMods = event.modifierFlags.intersection(.deviceIndependentFlagsMask).subtracting(.numericPad)
            guard eventMods == targetModifiers,
                  event.charactersIgnoringModifiers?.lowercased() == targetKey.lowercased() else { return }
            Task { @MainActor in
                guard self?.isBootstrapping != true else { return }
                self?.showMainWindow()
            }
        }

        lastRegisteredGlobalHotkey = shortcut
    }

    func setupEscapeMonitor() {
        escapeMonitor = NSEvent.addGlobalMonitorForEvents(matching: .keyDown) { [weak self] event in
            if event.keyCode == 53 { // Escape
                Task { @MainActor in
                    self?.startSessionTask?.cancel()
                    self?.thinkingWindow?.close()
                    self?.thinkingWindow = nil
                    self?.currentSession?.cancel()
                    self?.currentTextSession?.cancel()
                    self?.ambientAgent.resume()
                    self?.surfaceManager.dismissAll()
                    self?.toolConfirmationNotificationService.dismissAll()
                    self?.secretPromptManager.dismissAll()
                }
            }
        }
    }
}
