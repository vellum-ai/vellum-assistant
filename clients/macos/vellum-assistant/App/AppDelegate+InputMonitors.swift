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
    @objc dynamic var quickInputAboveDockShortcut: String {
        if UserDefaults.standard.object(forKey: "quickInputAboveDockShortcut") == nil {
            return "cmd+shift+v"
        }
        return string(forKey: "quickInputAboveDockShortcut") ?? ""
    }
    @objc dynamic var newThreadShortcut: String {
        if UserDefaults.standard.object(forKey: "newThreadShortcut") == nil {
            return "cmd+n"
        }
        return string(forKey: "newThreadShortcut") ?? ""
    }
    @objc dynamic var commandPaletteShortcut: String {
        if UserDefaults.standard.object(forKey: "commandPaletteShortcut") == nil {
            return "cmd+k"
        }
        return string(forKey: "commandPaletteShortcut") ?? ""
    }
    @objc dynamic var navigateBackShortcut: String {
        if UserDefaults.standard.object(forKey: "navigateBackShortcut") == nil {
            return "cmd+["
        }
        return string(forKey: "navigateBackShortcut") ?? ""
    }
    @objc dynamic var navigateForwardShortcut: String {
        if UserDefaults.standard.object(forKey: "navigateForwardShortcut") == nil {
            return "cmd+]"
        }
        return string(forKey: "navigateForwardShortcut") ?? ""
    }
    @objc dynamic var zoomInShortcut: String {
        if UserDefaults.standard.object(forKey: "zoomInShortcut") == nil {
            return "cmd+="
        }
        return string(forKey: "zoomInShortcut") ?? ""
    }
    @objc dynamic var zoomOutShortcut: String {
        if UserDefaults.standard.object(forKey: "zoomOutShortcut") == nil {
            return "cmd+-"
        }
        return string(forKey: "zoomOutShortcut") ?? ""
    }
    @objc dynamic var zoomResetShortcut: String {
        if UserDefaults.standard.object(forKey: "zoomResetShortcut") == nil {
            return "cmd+0"
        }
        return string(forKey: "zoomResetShortcut") ?? ""
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
        registerCmdNMonitor()
        registerNavigationMonitor()
        registerZoomMonitor()

        globalHotkeyObserver = Publishers.MergeMany([
            UserDefaults.standard.publisher(for: \.globalHotkeyShortcut).map { _ in () }.eraseToAnyPublisher(),
            UserDefaults.standard.publisher(for: \.quickInputHotkeyShortcut).map { _ in () }.eraseToAnyPublisher(),
            UserDefaults.standard.publisher(for: \.quickInputHotkeyKeyCode).map { _ in () }.eraseToAnyPublisher(),
            UserDefaults.standard.publisher(for: \.quickInputAboveDockShortcut).map { _ in () }.eraseToAnyPublisher(),
            UserDefaults.standard.publisher(for: \.newThreadShortcut).map { _ in () }.eraseToAnyPublisher(),
            UserDefaults.standard.publisher(for: \.commandPaletteShortcut).map { _ in () }.eraseToAnyPublisher(),
            UserDefaults.standard.publisher(for: \.navigateBackShortcut).map { _ in () }.eraseToAnyPublisher(),
            UserDefaults.standard.publisher(for: \.navigateForwardShortcut).map { _ in () }.eraseToAnyPublisher(),
            UserDefaults.standard.publisher(for: \.zoomInShortcut).map { _ in () }.eraseToAnyPublisher(),
            UserDefaults.standard.publisher(for: \.zoomOutShortcut).map { _ in () }.eraseToAnyPublisher(),
            UserDefaults.standard.publisher(for: \.zoomResetShortcut).map { _ in () }.eraseToAnyPublisher(),
        ])
        .debounce(for: .milliseconds(100), scheduler: RunLoop.main)
        .sink { [weak self] _ in
            self?.registerGlobalHotkeyMonitor()
            self?.registerQuickInputMonitor()
            self?.registerFnVMonitor()
            self?.registerCmdKMonitor()
            self?.registerCmdNMonitor()
            self?.registerNavigationMonitor()
            self?.registerZoomMonitor()
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
        if let monitor = cmdNLocalMonitor {
            NSEvent.removeMonitor(monitor)
            cmdNLocalMonitor = nil
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

    /// Registers the Quick Input Above Dock shortcut (default Cmd+Shift+V) as a
    /// global + local monitor. Reads the shortcut from UserDefaults and skips
    /// re-registration if unchanged. An empty shortcut disables the feature.
    func registerFnVMonitor() {
        let shortcut = UserDefaults.standard.string(forKey: "quickInputAboveDockShortcut") ?? "cmd+shift+v"

        if shortcut == lastRegisteredQuickInputAboveDockShortcut { return }

        // Tear down previous monitors
        if let monitor = fnVGlobalMonitor {
            NSEvent.removeMonitor(monitor)
            fnVGlobalMonitor = nil
        }
        if let monitor = fnVLocalMonitor {
            NSEvent.removeMonitor(monitor)
            fnVLocalMonitor = nil
        }

        guard !shortcut.isEmpty else {
            lastRegisteredQuickInputAboveDockShortcut = shortcut
            log.info("Quick Input Above Dock: shortcut disabled")
            return
        }

        let (targetModifiers, targetKey) = ShortcutHelper.parseShortcut(shortcut)

        let handler: (NSEvent) -> NSEvent? = { [weak self] event in
            let mods = event.modifierFlags.intersection(.deviceIndependentFlagsMask)
            guard mods == targetModifiers,
                  event.charactersIgnoringModifiers?.lowercased() == targetKey.lowercased() else {
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

        lastRegisteredQuickInputAboveDockShortcut = shortcut
    }

    /// Registers a local shortcut to create a new thread.
    /// Reads the shortcut from UserDefaults (`newThreadShortcut`), defaulting to "cmd+n".
    /// Skips re-registration if the shortcut hasn't changed.
    func registerCmdNMonitor() {
        let shortcut = UserDefaults.standard.string(forKey: "newThreadShortcut") ?? "cmd+n"

        if shortcut == lastRegisteredNewThreadShortcut { return }

        // Tear down previous monitor
        if let monitor = cmdNLocalMonitor {
            NSEvent.removeMonitor(monitor)
            cmdNLocalMonitor = nil
        }

        guard !shortcut.isEmpty else {
            lastRegisteredNewThreadShortcut = shortcut
            log.info("New Thread: shortcut disabled")
            return
        }

        let (targetModifiers, targetKey) = ShortcutHelper.parseShortcut(shortcut)

        let handler: (NSEvent) -> NSEvent? = { [weak self] event in
            let mods = event.modifierFlags.intersection(.deviceIndependentFlagsMask)
            guard mods == targetModifiers,
                  event.charactersIgnoringModifiers?.lowercased() == targetKey.lowercased() else {
                return event
            }
            Task { @MainActor in
                guard self?.isBootstrapping != true else { return }
                self?.createNewThread()
            }
            return nil
        }
        cmdNLocalMonitor = NSEvent.addLocalMonitorForEvents(matching: .keyDown, handler: handler)

        lastRegisteredNewThreadShortcut = shortcut
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
        let backShortcut = UserDefaults.standard.string(forKey: "navigateBackShortcut") ?? "cmd+["
        let forwardShortcut = UserDefaults.standard.string(forKey: "navigateForwardShortcut") ?? "cmd+]"

        // Skip re-registration if neither shortcut changed.
        if backShortcut == lastRegisteredNavBackShortcut,
           forwardShortcut == lastRegisteredNavForwardShortcut { return }

        // Tear down existing monitor before re-registration.
        if let monitor = navLocalMonitor {
            NSEvent.removeMonitor(monitor)
            navLocalMonitor = nil
        }

        // If both shortcuts are disabled, record state and return.
        guard !backShortcut.isEmpty || !forwardShortcut.isEmpty else {
            lastRegisteredNavBackShortcut = backShortcut
            lastRegisteredNavForwardShortcut = forwardShortcut
            log.info("Navigation: both shortcuts disabled")
            return
        }

        // Parse shortcuts into modifier flags and key strings.
        let backParsed: (NSEvent.ModifierFlags, String)? = backShortcut.isEmpty ? nil : ShortcutHelper.parseShortcut(backShortcut)
        let forwardParsed: (NSEvent.ModifierFlags, String)? = forwardShortcut.isEmpty ? nil : ShortcutHelper.parseShortcut(forwardShortcut)

        let handler: (NSEvent) -> NSEvent? = { [weak self] event in
            let mods = event.modifierFlags.intersection(.deviceIndependentFlagsMask)
            guard let chars = event.charactersIgnoringModifiers else { return event }

            // Check back shortcut
            if let (backMods, backKey) = backParsed,
               mods == backMods,
               chars.lowercased() == backKey.lowercased() {
                guard self?.mainWindow?.windowState.navigationHistory.canGoBack == true else { return event }
                Task { @MainActor in
                    self?.mainWindow?.windowState.navigateBack()
                }
                return nil
            }

            // Check forward shortcut
            if let (fwdMods, fwdKey) = forwardParsed,
               mods == fwdMods,
               chars.lowercased() == fwdKey.lowercased() {
                guard self?.mainWindow?.windowState.navigationHistory.canGoForward == true else { return event }
                Task { @MainActor in
                    self?.mainWindow?.windowState.navigateForward()
                }
                return nil
            }

            return event
        }
        navLocalMonitor = NSEvent.addLocalMonitorForEvents(matching: .keyDown, handler: handler)

        lastRegisteredNavBackShortcut = backShortcut
        lastRegisteredNavForwardShortcut = forwardShortcut
    }

    /// Registers zoom shortcuts as local event monitors for window zoom.
    /// Reads `zoomInShortcut`, `zoomOutShortcut`, and `zoomResetShortcut` from
    /// UserDefaults (defaults: "cmd+=", "cmd+-", "cmd+0"). Any shortcut can be
    /// independently disabled by setting it to an empty string.
    /// Uses event monitoring instead of NSMenu key equivalents because
    /// SwiftUI manages the menu bar and strips programmatic items.
    func registerZoomMonitor() {
        let zoomIn = UserDefaults.standard.string(forKey: "zoomInShortcut") ?? "cmd+="
        let zoomOut = UserDefaults.standard.string(forKey: "zoomOutShortcut") ?? "cmd+-"
        let zoomReset = UserDefaults.standard.string(forKey: "zoomResetShortcut") ?? "cmd+0"

        // Skip re-registration if all three shortcuts are unchanged
        if zoomIn == lastRegisteredZoomInShortcut
            && zoomOut == lastRegisteredZoomOutShortcut
            && zoomReset == lastRegisteredZoomResetShortcut { return }

        // Tear down existing monitor before re-registration
        if let monitor = zoomLocalMonitor {
            NSEvent.removeMonitor(monitor)
            zoomLocalMonitor = nil
        }

        // Parse each shortcut (empty strings yield empty key, which won't match)
        let (zoomInMods, zoomInKey) = ShortcutHelper.parseShortcut(zoomIn)
        let (zoomOutMods, zoomOutKey) = ShortcutHelper.parseShortcut(zoomOut)
        let (zoomResetMods, zoomResetKey) = ShortcutHelper.parseShortcut(zoomReset)

        // Only install the monitor if at least one shortcut is enabled
        let hasAnyShortcut = !zoomIn.isEmpty || !zoomOut.isEmpty || !zoomReset.isEmpty

        if hasAnyShortcut {
            let handler: (NSEvent) -> NSEvent? = { [weak self] event in
                let mods = event.modifierFlags.intersection(.deviceIndependentFlagsMask)
                guard let chars = event.charactersIgnoringModifiers else { return event }

                if !zoomInKey.isEmpty && chars.lowercased() == zoomInKey.lowercased() && mods == zoomInMods {
                    Task { @MainActor in self?.zoomManager.zoomIn() }
                    return nil
                }
                if !zoomOutKey.isEmpty && chars.lowercased() == zoomOutKey.lowercased() && mods == zoomOutMods {
                    Task { @MainActor in self?.zoomManager.zoomOut() }
                    return nil
                }
                if !zoomResetKey.isEmpty && chars.lowercased() == zoomResetKey.lowercased() && mods == zoomResetMods {
                    Task { @MainActor in self?.zoomManager.resetZoom() }
                    return nil
                }
                return event
            }
            zoomLocalMonitor = NSEvent.addLocalMonitorForEvents(matching: .keyDown, handler: handler)
        }

        lastRegisteredZoomInShortcut = zoomIn
        lastRegisteredZoomOutShortcut = zoomOut
        lastRegisteredZoomResetShortcut = zoomReset
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
                self?.mainWindow?.windowState.showPanel(.settings)
            },
            CommandPaletteAction(id: "app-directory", icon: VIcon.layoutGrid.rawValue, label: "Things", shortcutHint: nil) { [weak self] in
                self?.mainWindow?.windowState.showPanel(.apps)
            },
            CommandPaletteAction(id: "intelligence", icon: VIcon.brain.rawValue, label: "Intelligence", shortcutHint: nil) { [weak self] in
                self?.mainWindow?.windowState.showPanel(.intelligence)
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
                    self?.currentSession?.cancel()
                    self?.ambientAgent.resume()
                    self?.surfaceManager.dismissAll()
                    self?.toolConfirmationNotificationService.dismissAll()
                    self?.secretPromptManager.dismissAll()
                }
            }
        }
    }
}
