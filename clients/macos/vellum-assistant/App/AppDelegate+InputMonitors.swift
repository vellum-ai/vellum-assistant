import AppKit
import Carbon
import Combine
import VellumAssistantShared
import os

private let log = Logger(subsystem: Bundle.appBundleIdentifier, category: "AppDelegate")

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
    @objc dynamic var sidebarToggleShortcut: String {
        if UserDefaults.standard.object(forKey: "sidebarToggleShortcut") == nil {
            return "cmd+\\"
        }
        return string(forKey: "sidebarToggleShortcut") ?? ""
    }
    @objc dynamic var newChatShortcut: String {
        if UserDefaults.standard.object(forKey: "newChatShortcut") == nil {
            return "cmd+n"
        }
        return string(forKey: "newChatShortcut") ?? ""
    }
    @objc dynamic var currentConversationShortcut: String {
        if UserDefaults.standard.object(forKey: "currentConversationShortcut") == nil {
            return "cmd+shift+n"
        }
        return string(forKey: "currentConversationShortcut") ?? ""
    }
    @objc dynamic var markConversationUnreadShortcut: String {
        if UserDefaults.standard.object(forKey: "markConversationUnreadShortcut") == nil {
            return "cmd+shift+u"
        }
        return string(forKey: "markConversationUnreadShortcut") ?? ""
    }
    @objc dynamic var popOutShortcut: String {
        if UserDefaults.standard.object(forKey: "popOutShortcut") == nil {
            return "cmd+p"
        }
        return string(forKey: "popOutShortcut") ?? ""
    }
    @objc dynamic var homeShortcut: String {
        if UserDefaults.standard.object(forKey: "homeShortcut") == nil {
            return "cmd+shift+h"
        }
        return string(forKey: "homeShortcut") ?? ""
    }
    @objc dynamic var previousConversationShortcut: String {
        if UserDefaults.standard.object(forKey: "previousConversationShortcut") == nil {
            return "cmd+up"
        }
        return string(forKey: "previousConversationShortcut") ?? ""
    }
    @objc dynamic var nextConversationShortcut: String {
        if UserDefaults.standard.object(forKey: "nextConversationShortcut") == nil {
            return "cmd+down"
        }
        return string(forKey: "nextConversationShortcut") ?? ""
    }
    @objc dynamic var connectedOrganizationId: String? {
        return string(forKey: "connectedOrganizationId")
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
        registerNewChatMonitor()
        registerCurrentConversationMonitor()
        registerMarkConversationUnreadMonitor()
        registerPopOutMonitor()
        // `registerHomeShortcutMonitor()` is NOT called here — it's
        // registered in `proceedToApp()` alongside the other
        // post-bootstrap monitors (sidebar / nav / zoom) and
        // re-registered by the debounced sink below when the shortcut
        // changes. This matches the sidebar pattern.
        registerConversationNavMonitor()

        let shortcutPublishers: [AnyPublisher<Void, Never>] = [
            UserDefaults.standard.publisher(for: \.globalHotkeyShortcut).map { _ in () }.eraseToAnyPublisher(),
            UserDefaults.standard.publisher(for: \.quickInputHotkeyShortcut).map { _ in () }.eraseToAnyPublisher(),
            UserDefaults.standard.publisher(for: \.quickInputHotkeyKeyCode).map { _ in () }.eraseToAnyPublisher(),
            UserDefaults.standard.publisher(for: \.sidebarToggleShortcut).map { _ in () }.eraseToAnyPublisher(),
            UserDefaults.standard.publisher(for: \.newChatShortcut).map { _ in () }.eraseToAnyPublisher(),
            UserDefaults.standard.publisher(for: \.currentConversationShortcut).map { _ in () }.eraseToAnyPublisher(),
            UserDefaults.standard.publisher(for: \.markConversationUnreadShortcut).map { _ in () }.eraseToAnyPublisher(),
            UserDefaults.standard.publisher(for: \.popOutShortcut).map { _ in () }.eraseToAnyPublisher(),
            UserDefaults.standard.publisher(for: \.homeShortcut).map { _ in () }.eraseToAnyPublisher(),
            UserDefaults.standard.publisher(for: \.previousConversationShortcut).map { _ in () }.eraseToAnyPublisher(),
            UserDefaults.standard.publisher(for: \.nextConversationShortcut).map { _ in () }.eraseToAnyPublisher(),
        ]

        globalHotkeyObserver = Publishers.MergeMany(shortcutPublishers)
            .debounce(for: .milliseconds(100), scheduler: RunLoop.main)
            .sink { [weak self] _ in
                self?.registerGlobalHotkeyMonitor()
                self?.registerQuickInputMonitor()
                self?.registerSidebarToggleMonitor()
                self?.registerNewChatMonitor()
                self?.registerCurrentConversationMonitor()
                self?.registerMarkConversationUnreadMonitor()
                self?.registerPopOutMonitor()
                self?.registerHomeShortcutMonitor()
                self?.registerConversationNavMonitor()
                self?.updateNewChatMenuItemShortcut()
                self?.updateCurrentConversationMenuItemShortcut()
                self?.updateMarkConversationUnreadMenuItemShortcut()
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
        if let monitor = currentConversationLocalMonitor {
            NSEvent.removeMonitor(monitor)
            currentConversationLocalMonitor = nil
        }
        if let monitor = markConversationUnreadLocalMonitor {
            NSEvent.removeMonitor(monitor)
            markConversationUnreadLocalMonitor = nil
        }
        if let monitor = navLocalMonitor {
            NSEvent.removeMonitor(monitor)
            navLocalMonitor = nil
        }
        if let monitor = zoomLocalMonitor {
            NSEvent.removeMonitor(monitor)
            zoomLocalMonitor = nil
        }
        if let monitor = sidebarToggleLocalMonitor {
            NSEvent.removeMonitor(monitor)
            sidebarToggleLocalMonitor = nil
        }
        if let monitor = popOutLocalMonitor {
            NSEvent.removeMonitor(monitor)
            popOutLocalMonitor = nil
        }
        if let monitor = homeShortcutLocalMonitor {
            NSEvent.removeMonitor(monitor)
            homeShortcutLocalMonitor = nil
        }
        if let monitor = conversationNavLocalMonitor {
            NSEvent.removeMonitor(monitor)
            conversationNavLocalMonitor = nil
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

    /// Registers a local event monitor to create a new conversation when the
    /// configured shortcut (default: Cmd+N) is pressed. The shortcut is read
    /// dynamically from UserDefaults so it can be reconfigured without restarting.
    func registerNewChatMonitor() {
        if let existing = cmdNLocalMonitor {
            NSEvent.removeMonitor(existing)
            cmdNLocalMonitor = nil
        }

        let shortcut = UserDefaults.standard.string(forKey: "newChatShortcut") ?? "cmd+n"
        guard !shortcut.isEmpty else { return }

        let (targetModifiers, targetKey) = ShortcutHelper.parseShortcut(shortcut)

        let handler: (NSEvent) -> NSEvent? = { [weak self] event in
            let mods = event.modifierFlags.intersection(.deviceIndependentFlagsMask).subtracting(.numericPad)
            guard mods == targetModifiers,
                  event.charactersIgnoringModifiers?.lowercased() == targetKey.lowercased() else {
                return event
            }
            Task { @MainActor in
                guard self?.isBootstrapping != true else { return }
                self?.openNewChat()
            }
            return nil
        }
        cmdNLocalMonitor = NSEvent.addLocalMonitorForEvents(matching: .keyDown, handler: handler)
    }

    /// Registers a local event monitor to open the current conversation when the
    /// configured shortcut (default: Cmd+Shift+N) is pressed. The shortcut is read
    /// dynamically from UserDefaults so it can be reconfigured without restarting.
    func registerCurrentConversationMonitor() {
        if let existing = currentConversationLocalMonitor {
            NSEvent.removeMonitor(existing)
            currentConversationLocalMonitor = nil
        }

        let shortcut = UserDefaults.standard.string(forKey: "currentConversationShortcut") ?? "cmd+shift+n"
        guard !shortcut.isEmpty else { return }

        let (targetModifiers, targetKey) = ShortcutHelper.parseShortcut(shortcut)

        let handler: (NSEvent) -> NSEvent? = { [weak self] event in
            let mods = event.modifierFlags.intersection(.deviceIndependentFlagsMask).subtracting(.numericPad)
            guard mods == targetModifiers,
                  event.charactersIgnoringModifiers?.lowercased() == targetKey.lowercased() else {
                return event
            }
            Task { @MainActor in
                guard self?.isBootstrapping != true else { return }
                self?.openCurrentConversation()
            }
            return nil
        }
        currentConversationLocalMonitor = NSEvent.addLocalMonitorForEvents(matching: .keyDown, handler: handler)
    }

    /// Registers a local event monitor to mark the active conversation as unread
    /// when the configured shortcut (default: Cmd+Shift+U) is pressed. The shortcut
    /// is read dynamically from UserDefaults so it can be reconfigured without
    /// restarting. Using a persistent local monitor keeps the shortcut active
    /// regardless of whether the SwiftUI-managed File menu has been opened.
    func registerMarkConversationUnreadMonitor() {
        if let existing = markConversationUnreadLocalMonitor {
            NSEvent.removeMonitor(existing)
            markConversationUnreadLocalMonitor = nil
        }

        let shortcut = UserDefaults.standard.string(forKey: "markConversationUnreadShortcut") ?? "cmd+shift+u"
        guard !shortcut.isEmpty else { return }

        let (targetModifiers, targetKey) = ShortcutHelper.parseShortcut(shortcut)

        let handler: (NSEvent) -> NSEvent? = { [weak self] event in
            guard self?.isBootstrapping != true,
                  self?.mainWindow?.isVisible == true else { return event }
            let mods = event.modifierFlags.intersection(.deviceIndependentFlagsMask).subtracting(.numericPad)
            guard mods == targetModifiers,
                  event.charactersIgnoringModifiers?.lowercased() == targetKey.lowercased() else {
                return event
            }
            guard self?.canMarkCurrentConversationUnread() == true else {
                return event
            }
            Task { @MainActor in
                self?.markCurrentConversationUnread()
            }
            return nil
        }
        markConversationUnreadLocalMonitor = NSEvent.addLocalMonitorForEvents(matching: .keyDown, handler: handler)
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
                guard self?.mainWindow?.windowState.canGoBack == true else { return event }
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

    /// Registers a local event monitor to toggle the sidebar collapsed/expanded
    /// state when the configured shortcut (default: Cmd+\) is pressed.
    /// The shortcut is read dynamically from UserDefaults so it can be
    /// reconfigured without restarting.
    func registerSidebarToggleMonitor() {
        if let existing = sidebarToggleLocalMonitor {
            NSEvent.removeMonitor(existing)
            sidebarToggleLocalMonitor = nil
        }

        let shortcut = UserDefaults.standard.string(forKey: "sidebarToggleShortcut") ?? "cmd+\\"
        guard !shortcut.isEmpty else { return }

        let (targetModifiers, targetKey) = ShortcutHelper.parseShortcut(shortcut)

        let handler: (NSEvent) -> NSEvent? = { [weak self] event in
            guard self?.isBootstrapping != true,
                  self?.mainWindow?.isVisible == true else { return event }
            let mods = event.modifierFlags.intersection(.deviceIndependentFlagsMask).subtracting(.numericPad)
            guard mods == targetModifiers,
                  event.charactersIgnoringModifiers?.lowercased() == targetKey.lowercased() else {
                return event
            }
            let current = (UserDefaults.standard.object(forKey: "sidebarExpanded") as? Bool) ?? true
            UserDefaults.standard.set(!current, forKey: "sidebarExpanded")
            return nil
        }
        sidebarToggleLocalMonitor = NSEvent.addLocalMonitorForEvents(matching: .keyDown, handler: handler)
    }

    /// Registers a local event monitor to pop out the active conversation into
    /// a new window when the configured shortcut (default: Cmd+P) is pressed.
    /// The shortcut is read dynamically from UserDefaults so it can be
    /// reconfigured without restarting.
    func registerPopOutMonitor() {
        if let existing = popOutLocalMonitor {
            NSEvent.removeMonitor(existing)
            popOutLocalMonitor = nil
        }

        let shortcut = UserDefaults.standard.string(forKey: "popOutShortcut") ?? "cmd+p"
        guard !shortcut.isEmpty else { return }

        let (targetModifiers, targetKey) = ShortcutHelper.parseShortcut(shortcut)

        let handler: (NSEvent) -> NSEvent? = { [weak self] event in
            guard self?.isBootstrapping != true,
                  self?.mainWindow?.isVisible == true else { return event }
            let mods = event.modifierFlags.intersection(.deviceIndependentFlagsMask).subtracting(.numericPad)
            guard mods == targetModifiers,
                  event.charactersIgnoringModifiers?.lowercased() == targetKey.lowercased() else {
                return event
            }
            Task { @MainActor in
                self?.popOutActiveConversation()
            }
            return nil
        }
        popOutLocalMonitor = NSEvent.addLocalMonitorForEvents(matching: .keyDown, handler: handler)
    }

    /// Registers a local event monitor to jump to the Home panel when the
    /// configured shortcut (default: Cmd+Shift+H) is pressed. The shortcut
    /// is read dynamically from UserDefaults so it can be reconfigured
    /// from Settings without restarting.
    func registerHomeShortcutMonitor() {
        if let existing = homeShortcutLocalMonitor {
            NSEvent.removeMonitor(existing)
            homeShortcutLocalMonitor = nil
        }

        let shortcut = UserDefaults.standard.string(forKey: "homeShortcut") ?? "cmd+shift+h"
        guard !shortcut.isEmpty else { return }

        let (targetModifiers, targetKey) = ShortcutHelper.parseShortcut(shortcut)

        let handler: (NSEvent) -> NSEvent? = { [weak self] event in
            guard self?.isBootstrapping != true,
                  self?.mainWindow?.isVisible == true,
                  // Feature-flag check lives in the monitor (not just in
                  // `openHomePanel()`) so the key chord falls through to
                  // the responder chain / menu items when Home is disabled
                  // — otherwise we'd silently swallow ⌘⇧H for no effect.
                  MacOSClientFeatureFlagManager.shared.isEnabled("home-tab") else { return event }
            let mods = event.modifierFlags.intersection(.deviceIndependentFlagsMask).subtracting(.numericPad)
            guard mods == targetModifiers,
                  event.charactersIgnoringModifiers?.lowercased() == targetKey.lowercased() else {
                return event
            }
            Task { @MainActor in
                self?.openHomePanel()
            }
            return nil
        }
        homeShortcutLocalMonitor = NSEvent.addLocalMonitorForEvents(matching: .keyDown, handler: handler)
    }

    /// Registers configurable shortcuts for navigating between conversations
    /// in the sidebar (default: Cmd+Up / Cmd+Down). The shortcuts are read
    /// dynamically from UserDefaults so they can be reconfigured without
    /// restarting. Skips the event when the first responder is a text view
    /// to avoid stealing standard text editing key bindings.
    func registerConversationNavMonitor() {
        if let existing = conversationNavLocalMonitor {
            NSEvent.removeMonitor(existing)
            conversationNavLocalMonitor = nil
        }

        let prevShortcut = UserDefaults.standard.string(forKey: "previousConversationShortcut") ?? "cmd+up"
        let nextShortcut = UserDefaults.standard.string(forKey: "nextConversationShortcut") ?? "cmd+down"

        guard !prevShortcut.isEmpty || !nextShortcut.isEmpty else { return }

        let (prevModifiers, prevKey) = ShortcutHelper.parseShortcut(prevShortcut)
        let (nextModifiers, nextKey) = ShortcutHelper.parseShortcut(nextShortcut)
        let prevMods = prevModifiers.subtracting(.function)
        let nextMods = nextModifiers.subtracting(.function)

        let handler: (NSEvent) -> NSEvent? = { [weak self] event in
            guard self?.isBootstrapping != true,
                  self?.mainWindow?.isVisible == true else { return event }

            // Don't steal shortcuts from text views (e.g. Cmd+Up/Down for caret movement)
            if NSApp.mainWindow?.firstResponder is NSTextView { return event }

            // Arrow keys include .numericPad and .function in modifierFlags — strip both
            let mods = event.modifierFlags.intersection(.deviceIndependentFlagsMask)
                .subtracting([.numericPad, .function])

            if !prevShortcut.isEmpty,
               mods == prevMods,
               event.charactersIgnoringModifiers?.lowercased() == prevKey.lowercased() {
                Task { @MainActor in self?.selectPreviousConversation() }
                return nil
            }
            if !nextShortcut.isEmpty,
               mods == nextMods,
               event.charactersIgnoringModifiers?.lowercased() == nextKey.lowercased() {
                Task { @MainActor in self?.selectNextConversation() }
                return nil
            }
            return event
        }
        conversationNavLocalMonitor = NSEvent.addLocalMonitorForEvents(matching: .keyDown, handler: handler)
    }

    /// Select the previous conversation in the sidebar's visible list.
    private func selectPreviousConversation() {
        guard let mainWindow else { return }
        let visible = mainWindow.conversationManager.visibleConversations
        guard !visible.isEmpty else { return }
        let activeId = mainWindow.conversationManager.activeConversationId
        guard let currentIndex = visible.firstIndex(where: { $0.id == activeId }) else {
            // No active conversation or not in visible list — select the first one
            mainWindow.conversationManager.selectConversation(id: visible[0].id)
            mainWindow.windowState.selection = .conversation(visible[0].id)
            return
        }
        guard currentIndex > 0 else { return } // already at top
        let targetId = visible[currentIndex - 1].id
        mainWindow.conversationManager.selectConversation(id: targetId)
        mainWindow.windowState.selection = .conversation(targetId)
    }

    /// Select the next conversation in the sidebar's visible list.
    private func selectNextConversation() {
        guard let mainWindow else { return }
        let visible = mainWindow.conversationManager.visibleConversations
        guard !visible.isEmpty else { return }
        let activeId = mainWindow.conversationManager.activeConversationId
        guard let currentIndex = visible.firstIndex(where: { $0.id == activeId }) else {
            mainWindow.conversationManager.selectConversation(id: visible[0].id)
            mainWindow.windowState.selection = .conversation(visible[0].id)
            return
        }
        guard currentIndex < visible.count - 1 else { return } // already at bottom
        let targetId = visible[currentIndex + 1].id
        mainWindow.conversationManager.selectConversation(id: targetId)
        mainWindow.windowState.selection = .conversation(targetId)
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
            CommandPaletteAction(id: "new-conversation", icon: VIcon.squarePen.rawValue, label: "New Conversation", shortcutHint: {
                let shortcut = UserDefaults.standard.string(forKey: "newChatShortcut") ?? "cmd+n"
                return shortcut.isEmpty ? nil : ShortcutHelper.displayString(for: shortcut)
            }()) { [weak self] in
                self?.mainWindow?.conversationManager.createConversation()
                SoundManager.shared.play(.newConversation)
                if let id = self?.mainWindow?.conversationManager.activeConversationId {
                    self?.mainWindow?.windowState.selection = .conversation(id)
                }
            },
            CommandPaletteAction(id: "current-conversation", icon: VIcon.messageSquare.rawValue, label: "Current Conversation", shortcutHint: {
                let shortcut = UserDefaults.standard.string(forKey: "currentConversationShortcut") ?? "cmd+shift+n"
                return shortcut.isEmpty ? nil : ShortcutHelper.displayString(for: shortcut)
            }()) { [weak self] in
                self?.openCurrentConversation()
            },
            CommandPaletteAction(id: "settings", icon: VIcon.settings.rawValue, label: "Settings", shortcutHint: "\u{2318},") { [weak self] in
                self?.mainWindow?.windowState.showPanel(.settings)
            },
            CommandPaletteAction(id: "app-directory", icon: VIcon.layoutGrid.rawValue, label: "Library", shortcutHint: nil) { [weak self] in
                self?.mainWindow?.windowState.showPanel(.apps)
            },
            CommandPaletteAction(id: "intelligence", icon: VIcon.brain.rawValue, label: AssistantDisplayName.resolve(IdentityInfo.current?.name, fallback: "Your Assistant"), shortcutHint: nil) { [weak self] in
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

        // Recent conversations from ConversationManager
        if let conversations = mainWindow?.conversationManager.conversations {
            window.recentItems = conversations
                .filter { !$0.isArchived }
                .sorted { $0.lastInteractedAt > $1.lastInteractedAt }
                .prefix(5)
                .map { CommandPaletteRecentItem(id: $0.id, title: $0.title, lastInteracted: $0.lastInteractedAt) }
        }

        window.onSelectConversation = { [weak self] conversationId in
            self?.mainWindow?.conversationManager.selectConversation(id: conversationId)
        }

        window.onSelectSearchConversation = { [weak self] conversationId in
            Task { @MainActor in
                let found = await self?.mainWindow?.conversationManager.selectConversationByConversationIdAsync(conversationId) ?? false
                if found, let activeId = self?.mainWindow?.conversationManager.activeConversationId {
                    self?.mainWindow?.windowState.selection = .conversation(activeId)
                }
            }
        }

        window.onSelectMemory = { [weak self] memoryId in
            self?.mainWindow?.windowState.showMemory(id: memoryId)
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
        window.onSubmit = { [weak self] message, imageData in
            self?.handleQuickInputSubmit(message, imageData: imageData)
        }
        window.onSubmitToConversation = { [weak self] message, imageData in
            self?.handleQuickInputSubmitToConversation(message, imageData: imageData)
        }
        window.onSelectConversation = { [weak self] conversationId in
            self?.handleQuickInputSelectConversation(conversationId)
        }
        window.onMicrophoneToggle = { [weak self] in
            self?.voiceInput?.toggleRecording()
        }
        // Provide the 3 most recent non-archived conversations
        if let conversations = mainWindow?.conversationManager.conversations {
            window.recentConversations = conversations
                .filter { !$0.isArchived }
                .sorted { $0.lastInteractedAt > $1.lastInteractedAt }
                .prefix(3)
                .map { QuickInputConversation(id: $0.id, title: $0.title) }
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
            window.onSubmit = { [weak self] message, imgData in
                self?.handleQuickInputSubmit(message, imageData: imgData)
            }
            window.onSubmitToConversation = { [weak self] message, imgData in
                self?.handleQuickInputSubmitToConversation(message, imageData: imgData)
            }
            window.onSelectConversation = { [weak self] conversationId in
                self?.handleQuickInputSelectConversation(conversationId)
            }
            window.onMicrophoneToggle = { [weak self] in
                self?.voiceInput?.toggleRecording()
            }
            if let conversations = self.mainWindow?.conversationManager.conversations {
                window.recentConversations = conversations
                    .filter { !$0.isArchived }
                    .sorted { $0.lastInteractedAt > $1.lastInteractedAt }
                    .prefix(3)
                    .map { QuickInputConversation(id: $0.id, title: $0.title) }
            }
            window.setAttachment(imageData: imageData)
            window.showNearRect(selectionRect)
            self.quickInputWindow = window
        }
        selectionWindow.onCancel = { /* User cancelled — do nothing */ }
        selectionWindow.show()
    }

    func handleQuickInputSubmit(_ message: String, imageData: Data?) {
        // Ensure mainWindow exists so we can get a ChatViewModel.
        // Never show it — quick input is fire-and-forget.
        ensureMainWindowExists()
        guard let mainWindow else { return }
        mainWindow.conversationManager.createConversation()
        SoundManager.shared.play(.newConversation)
        if let conversationId = mainWindow.conversationManager.activeConversationId {
            mainWindow.windowState.selection = .conversation(conversationId)
        }
        guard let viewModel = mainWindow.activeViewModel else { return }

        if let imageData {
            viewModel.addAttachment(imageData: imageData, filename: "Screenshot.jpg")
            viewModel.inputText = message
            quickInputAttachmentCancellable = viewModel.attachmentManager.isLoadingAttachmentPublisher
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

    func handleQuickInputSubmitToConversation(_ message: String, imageData: Data?) {
        guard let mainWindow else { return }
        if let viewModel = mainWindow.activeViewModel {
            viewModel.inputText = message
            if let imageData {
                viewModel.addAttachment(imageData: imageData, filename: "Screenshot.jpg")
                quickInputAttachmentCancellable = viewModel.attachmentManager.isLoadingAttachmentPublisher
                    .filter { !$0 }
                    .first()
                    .sink { [weak self] _ in
                        viewModel.sendMessage()
                        self?.quickInputAttachmentCancellable = nil
                    }
            } else {
                viewModel.sendMessage()
            }
        }
    }

    func handleQuickInputSelectConversation(_ conversationId: UUID) {
        showMainWindow()
        guard let mainWindow else { return }
        mainWindow.conversationManager.activateConversation(conversationId)
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
                    self?.surfaceManager.dismissFloatingOnly()
                    self?.toolConfirmationNotificationService.dismissAll()
                    self?.secretPromptManager.dismissAll()
                }
            }
        }
    }
}
