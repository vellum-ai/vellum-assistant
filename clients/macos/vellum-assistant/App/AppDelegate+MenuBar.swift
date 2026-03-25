import AppKit
@preconcurrency import Sentry
import SwiftUI
import VellumAssistantShared
import os

private let log = Logger(subsystem: Bundle.main.bundleIdentifier ?? "com.vellum.vellum-assistant", category: "AppDelegate+MenuBar")

extension Notification.Name {
    /// Posted when the user triggers Edit > Find (Cmd+F) from the menu bar.
    static let activateChatSearch = Notification.Name("activateChatSearch")
}

/// Delegate installed on the app submenu to patch the menu bar title to
/// "Vellum" right before macOS renders it.  SwiftUI resets the title from
/// the bundle display name, so we override it in `menuWillOpen`.
final class AppMenuPatchDelegate: NSObject, NSMenuDelegate {
    let bundleDisplayName: String

    init(bundleDisplayName: String) {
        self.bundleDisplayName = bundleDisplayName
    }

    func menuWillOpen(_ menu: NSMenu) {
        patchTitles(menu: menu)
    }

    @MainActor func patchTitles(menu: NSMenu) {
        let name = AppDelegate.appName
        // Patch the parent menu item title (the bold text in the menu bar).
        if let mainMenu = NSApp.mainMenu,
           let appMenuItem = mainMenu.items.first,
           appMenuItem.title != name {
            appMenuItem.title = name
        }
        if menu.title != name {
            menu.title = name
        }
        // Patch only the system-generated app-name items (About, Hide, Quit).
        // A blanket replacingOccurrences would break if the bundle name were
        // a common word like "All" or "Settings".
        let prefixes = ["About ", "Hide ", "Quit "]
        for item in menu.items {
            for prefix in prefixes where item.title == "\(prefix)\(bundleDisplayName)" {
                item.title = "\(prefix)\(name)"
            }
        }
    }
}

/// Delegate installed on the SwiftUI-managed File submenu to inject
/// "New Conversation" and "Current Conversation" items every time the menu opens.
/// SwiftUI rebuilds the File menu on each scene body evaluation (leaving
/// only "Close"), so AppKit-level insertions get wiped.  This delegate
/// re-applies them right before macOS renders the menu.
final class FileMenuPatchDelegate: NSObject, NSMenuDelegate {
    weak var appDelegate: AppDelegate?

    /// Tag used to identify items we injected so we can avoid duplicates.
    private static let injectedTag = 9001

    func menuWillOpen(_ menu: NSMenu) {
        guard let appDelegate else { return }

        // Already patched for this open cycle — skip.
        if menu.items.first(where: { $0.tag == Self.injectedTag }) != nil { return }

        let shortcut = UserDefaults.standard.string(forKey: "newChatShortcut") ?? "cmd+n"
        let newChatItem: NSMenuItem
        if shortcut.isEmpty {
            newChatItem = NSMenuItem(title: "New Conversation", action: #selector(AppDelegate.openNewChat), keyEquivalent: "")
        } else {
            let (modifiers, key) = ShortcutHelper.parseShortcut(shortcut)
            newChatItem = NSMenuItem(title: "New Conversation", action: #selector(AppDelegate.openNewChat), keyEquivalent: key)
            newChatItem.keyEquivalentModifierMask = modifiers
        }
        newChatItem.target = appDelegate
        newChatItem.tag = Self.injectedTag
        menu.insertItem(newChatItem, at: 0)

        let currentConversationShortcut = UserDefaults.standard.string(forKey: "currentConversationShortcut") ?? "cmd+shift+n"
        let currentItem: NSMenuItem
        if currentConversationShortcut.isEmpty {
            currentItem = NSMenuItem(title: "Current Conversation", action: #selector(AppDelegate.openCurrentConversation), keyEquivalent: "")
        } else {
            let (ccModifiers, ccKey) = ShortcutHelper.parseShortcut(currentConversationShortcut)
            currentItem = NSMenuItem(title: "Current Conversation", action: #selector(AppDelegate.openCurrentConversation), keyEquivalent: ccKey)
            currentItem.keyEquivalentModifierMask = ccModifiers
        }
        currentItem.target = appDelegate
        currentItem.tag = Self.injectedTag
        menu.insertItem(currentItem, at: 1)

        let separator = NSMenuItem.separator()
        separator.tag = Self.injectedTag
        menu.insertItem(separator, at: 2)
    }
}

extension AppDelegate {

    // MARK: - Menu Bar

    func setupMenuBar() {
        if statusItem != nil {
            NSStatusBar.system.removeStatusItem(statusItem)
            statusItem = nil
        }

        // Set saved position to right side of menu bar (visible area, right of notch)
        UserDefaults.standard.set(1200, forKey: "NSStatusItem Preferred Position VellumMenuBar")

        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        statusItem.autosaveName = "VellumMenuBar"
        statusItem.isVisible = true
        if let button = statusItem.button {
            configureMenuBarIcon(button)
            button.action = #selector(statusBarButtonClicked(_:))
            button.target = self
            button.sendAction(on: [.leftMouseUp, .rightMouseUp])
        }

        rebindConnectionStatusObserver()

        // Update menu bar icon when the assistant's avatar changes.
        if avatarChangeObserver == nil {
            avatarChangeObserver = NotificationCenter.default.addObserver(
                forName: AvatarAppearanceManager.avatarDidChangeNotification,
                object: nil,
                queue: .main
            ) { [weak self] _ in
                MainActor.assumeIsolated {
                    self?.updateMenuBarIcon()
                }
            }
        }
    }

    /// (Re-)subscribe to `connectionManager.$isConnected` so the menu bar icon
    /// tracks the current daemon client. Called from `setupMenuBar()` and
    /// again from `setupGatewayConnectionManager()` after transport reconfiguration.
    func rebindConnectionStatusObserver() {
        connectionStatusCancellable?.cancel()
        connectionStatusCancellable = connectionManager.$isConnected
            .receive(on: RunLoop.main)
            .sink { [weak self] _ in
                self?.updateMenuBarIcon()
            }
    }

    func setupFileMenu() {
        guard let mainMenu = NSApp.mainMenu else { return }

        // Ensure the File menu delegate is installed (may already be from
        // applicationDidFinishLaunching, but re-check in case SwiftUI
        // replaced the menu object).
        installFileMenuDelegate()

        // Edit menu — provides Cmd+F "Find" so the shortcut works regardless of focus state.
        if mainMenu.indexOfItem(withTitle: "Edit") < 0 {
            let editMenu = NSMenu(title: "Edit")

            // Standard undo/redo actions
            editMenu.addItem(NSMenuItem(title: "Undo", action: Selector(("undo:")), keyEquivalent: "z"))
            let redoItem = NSMenuItem(title: "Redo", action: Selector(("redo:")), keyEquivalent: "z")
            redoItem.keyEquivalentModifierMask = [.command, .shift]
            editMenu.addItem(redoItem)
            editMenu.addItem(NSMenuItem.separator())

            // Standard edit actions so Cmd+C/V/X/A work in text fields
            editMenu.addItem(NSMenuItem(title: "Cut", action: #selector(NSText.cut(_:)), keyEquivalent: "x"))
            editMenu.addItem(NSMenuItem(title: "Copy", action: #selector(NSText.copy(_:)), keyEquivalent: "c"))
            editMenu.addItem(NSMenuItem(title: "Paste", action: #selector(NSText.paste(_:)), keyEquivalent: "v"))
            editMenu.addItem(NSMenuItem(title: "Select All", action: #selector(NSText.selectAll(_:)), keyEquivalent: "a"))
            editMenu.addItem(NSMenuItem.separator())

            let findItem = NSMenuItem(title: "Find...", action: #selector(activateChatSearch), keyEquivalent: "f")
            findItem.keyEquivalentModifierMask = .command
            findItem.target = self
            editMenu.addItem(findItem)

            let editMenuItem = NSMenuItem(title: "Edit", action: nil, keyEquivalent: "")
            editMenuItem.submenu = editMenu
            mainMenu.insertItem(editMenuItem, at: 2)
        }

        updateNewChatMenuItemShortcut()
        updateCurrentConversationMenuItemShortcut()
    }

    /// Updates the File > New Conversation menu item's key equivalent to match
    /// the current `newChatShortcut` preference. Called once at setup and again
    /// whenever the preference changes via the KVO observer.
    func updateNewChatMenuItemShortcut() {
        guard let item = newChatMenuItem else { return }
        let shortcut = UserDefaults.standard.string(forKey: "newChatShortcut") ?? "cmd+n"
        guard !shortcut.isEmpty else {
            item.keyEquivalent = ""
            item.keyEquivalentModifierMask = []
            return
        }
        let (modifiers, key) = ShortcutHelper.parseShortcut(shortcut)
        item.keyEquivalent = key
        item.keyEquivalentModifierMask = modifiers
    }

    /// Updates the File > Current Conversation menu item's key equivalent to
    /// match the current `currentConversationShortcut` preference. Called once
    /// at setup and again whenever the preference changes via the KVO observer.
    func updateCurrentConversationMenuItemShortcut() {
        guard let item = currentConversationMenuItem else { return }
        let shortcut = UserDefaults.standard.string(forKey: "currentConversationShortcut") ?? "cmd+shift+n"
        guard !shortcut.isEmpty else {
            item.keyEquivalent = ""
            item.keyEquivalentModifierMask = []
            return
        }
        let (modifiers, key) = ShortcutHelper.parseShortcut(shortcut)
        item.keyEquivalent = key
        item.keyEquivalentModifierMask = modifiers
    }

    // MARK: - Menu Item Validation

    @objc func validateMenuItem(_ menuItem: NSMenuItem) -> Bool {
        guard let action = menuItem.action else { return true }
        if action == #selector(markAllConversationsSeen) {
            return (mainWindow?.conversationManager.unseenVisibleConversationCount ?? 0) > 0
        }
        return true
    }

    /// Builds the status item tooltip, appending PTT key info when enabled.
    private func menuBarTooltip() -> String {
        let activator = PTTActivator.fromStored()
        guard activator.kind != .none else { return "Vellum" }
        return "Vellum — hold \(activator.displayName) to talk"
    }

    func configureMenuBarIcon(_ button: NSStatusBarButton) {
        button.toolTip = menuBarTooltip()
        let iconSize: CGFloat = 18
        let dotSize: CGFloat = 6
        let dotPadding: CGFloat = 0.5

        let appIcon: NSImage = {
            // Use the assistant's avatar (same image used for dock icon / chat),
            // rendered as a circle at menu-bar size.
            let avatarManager = AvatarAppearanceManager.shared
            let avatar = avatarManager.customAvatarImage
                ?? avatarManager.fullAvatarImage

            let size = iconSize
            let square = AvatarAppearanceManager.resizedImage(avatar, to: size)
            return NSImage(size: NSSize(width: size, height: size), flipped: false) { rect in
                NSBezierPath(ovalIn: rect).addClip()
                square.draw(in: rect, from: NSRect(origin: .zero, size: square.size),
                            operation: .copy, fraction: 1.0)
                return true
            }
        }()

        let status = currentAssistantStatus
        let dotColor = status.statusColor
        let dotAlpha = status.shouldPulse ? pulsePhase : 1.0

        let composited = NSImage(
            size: NSSize(width: iconSize, height: iconSize), flipped: false
        ) { rect in
            appIcon.draw(in: rect, from: NSRect(origin: .zero, size: appIcon.size),
                         operation: .copy, fraction: 1.0)
            let dotX = iconSize - dotSize - dotPadding
            let dotY = dotPadding
            let dotRect = NSRect(x: dotX, y: dotY, width: dotSize, height: dotSize)
            NSColor(VColor.auxBlack).withAlphaComponent(0.5).setFill()
            NSBezierPath(ovalIn: dotRect.insetBy(dx: -0.5, dy: -0.5)).fill()
            dotColor.withAlphaComponent(dotAlpha).setFill()
            NSBezierPath(ovalIn: dotRect).fill()
            return true
        }
        composited.isTemplate = false
        button.image = composited

        managePulseTimer(for: status)
    }

    /// Starts or stops the pulse timer based on the current status.
    private func managePulseTimer(for status: AssistantStatus) {
        if status.shouldPulse {
            guard pulseTimer == nil else { return }
            pulsePhase = 1.0
            pulseDirection = -1.0
            pulseTimer = Timer.scheduledTimer(withTimeInterval: 0.05, repeats: true) { [weak self] _ in
                Task { @MainActor in
                    guard let self, self.statusItem != nil, let button = self.statusItem.button else { return }
                    // Triangle wave: smoothly oscillate between 1.0 and 0.3,
                    // reversing direction at each boundary to avoid abrupt jumps.
                    self.pulsePhase += self.pulseDirection * 0.05
                    if self.pulsePhase <= 0.3 {
                        self.pulsePhase = 0.3
                        self.pulseDirection = 1.0
                    } else if self.pulsePhase >= 1.0 {
                        self.pulsePhase = 1.0
                        self.pulseDirection = -1.0
                    }
                    self.configureMenuBarIcon(button)
                }
            }
        } else {
            pulseTimer?.invalidate()
            pulseTimer = nil
            pulsePhase = 1.0
            pulseDirection = -1.0
        }
    }

    var currentAssistantStatus: AssistantStatus {
        if !connectionManager.isConnected { return .disconnected }
        guard let viewModel = mainWindow?.conversationManager.activeViewModel else { return .idle }
        if let error = viewModel.errorText { return .error(error) }
        if viewModel.isThinking { return .thinking }
        return .idle
    }

    @objc func statusBarButtonClicked(_ sender: NSStatusBarButton) {
        guard let event = NSApp.currentEvent else {
            showStatusMenu()
            return
        }
        if (event.type == .rightMouseUp || event.modifierFlags.contains(.control)),
           MacOSClientFeatureFlagManager.shared.isEnabled("quick-input") {
            toggleQuickInput()
        } else {
            showStatusMenu()
        }
    }

    func showStatusMenu() {
        guard let button = statusItem.button else { return }
        let menu = NSMenu()
        menu.autoenablesItems = false

        let status = currentAssistantStatus
        let name = AssistantDisplayName.resolve(IdentityInfo.load()?.name)
        let statusItem = NSMenuItem(title: status.menuTitle(assistantName: name), action: nil, keyEquivalent: "")
        statusItem.isEnabled = false
        statusItem.image = status.statusIcon
        menu.addItem(statusItem)

        menu.addItem(NSMenuItem.separator())

        let currentConversationItem: NSMenuItem = {
            let shortcut = UserDefaults.standard.string(forKey: "currentConversationShortcut") ?? "cmd+shift+n"
            guard !shortcut.isEmpty else {
                return NSMenuItem(title: "Current Conversation", action: #selector(openCurrentConversation), keyEquivalent: "")
            }
            let (modifiers, key) = ShortcutHelper.parseShortcut(shortcut)
            let item = NSMenuItem(title: "Current Conversation", action: #selector(openCurrentConversation), keyEquivalent: key)
            item.keyEquivalentModifierMask = modifiers
            return item
        }()
        currentConversationItem.target = self
        currentConversationItem.image = VIcon.messageSquare.nsImage(size: 16)
        menu.addItem(currentConversationItem)

        let newChatItem: NSMenuItem = {
            let shortcut = UserDefaults.standard.string(forKey: "newChatShortcut") ?? "cmd+n"
            guard !shortcut.isEmpty else {
                return NSMenuItem(title: "New Conversation", action: #selector(openNewChat), keyEquivalent: "")
            }
            let (modifiers, key) = ShortcutHelper.parseShortcut(shortcut)
            let item = NSMenuItem(title: "New Conversation", action: #selector(openNewChat), keyEquivalent: key)
            item.keyEquivalentModifierMask = modifiers
            return item
        }()
        newChatItem.target = self
        newChatItem.image = VIcon.messageCirclePlus.nsImage(size: 16)
        menu.addItem(newChatItem)

        if MacOSClientFeatureFlagManager.shared.isEnabled("developer-menu-items") {
            menu.addItem(NSMenuItem.separator())

            let onboardingItem = NSMenuItem(title: "Replay Onboarding", action: #selector(replayOnboarding), keyEquivalent: "")
            onboardingItem.target = self
            menu.addItem(onboardingItem)

            #if DEBUG
            let galleryItem = NSMenuItem(title: "Component Gallery", action: #selector(showComponentGallery), keyEquivalent: "")
            galleryItem.target = self
            menu.addItem(galleryItem)
            #endif
        }

        menu.addItem(NSMenuItem.separator())

        let settingsItem = NSMenuItem(title: "Settings...", action: #selector(showSettingsWindow(_:)), keyEquivalent: ",")
        settingsItem.target = self
        settingsItem.image = VIcon.settings.nsImage(size: 16)
        menu.addItem(settingsItem)

        let updateItem = NSMenuItem(title: "Check for Updates...", action: #selector(checkForUpdates), keyEquivalent: "")
        updateItem.target = self
        updateItem.image = VIcon.circleArrowUp.nsImage(size: 16)
        menu.addItem(updateItem)

        let restartItem = NSMenuItem(title: "Restart", action: #selector(performRestart), keyEquivalent: "")
        restartItem.target = self
        restartItem.image = VIcon.refreshCw.nsImage(size: 16)
        menu.addItem(restartItem)

        let quitItem = NSMenuItem(title: "Quit", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        quitItem.image = VIcon.power.nsImage(size: 16)
        menu.addItem(quitItem)

        // Use native status item menu display for standard macOS positioning.
        // performClick blocks until the menu closes, so clearing the menu
        // afterward restores custom click handling in statusBarButtonClicked.
        self.statusItem.menu = menu
        button.performClick(nil)
        self.statusItem.menu = nil
    }

    @objc func markAllConversationsSeen() {
        guard let conversationManager = mainWindow?.conversationManager else { return }
        let markedIds = conversationManager.markAllConversationsSeen()
        guard !markedIds.isEmpty else { return }
        let count = markedIds.count
        let toastId = mainWindow?.windowState.showToast(
            message: "Marked \(count) conversation\(count == 1 ? "" : "s") as seen",
            style: .success,
            primaryAction: VToastAction(label: "Undo") { [weak self] in
                self?.mainWindow?.conversationManager.restoreUnseen(conversationIds: markedIds)
                self?.mainWindow?.windowState.dismissToast()
            },
            onDismiss: { [weak self] in
                self?.mainWindow?.conversationManager.commitPendingSeenSignals()
            }
        )
        conversationManager.schedulePendingSeenSignals { [weak self] in
            guard let toastId else { return }
            self?.mainWindow?.windowState.dismissToast(id: toastId)
        }
    }

    public func applicationDockMenu(_ sender: NSApplication) -> NSMenu? {
        let menu = NSMenu()

        let newChatItem = NSMenuItem(title: "New Conversation", action: #selector(openNewChat), keyEquivalent: "")
        newChatItem.target = self
        menu.addItem(newChatItem)

        let markAllSeenItem = NSMenuItem(
            title: "Mark All Conversations as Seen",
            action: #selector(markAllConversationsSeen),
            keyEquivalent: ""
        )
        markAllSeenItem.target = self
        menu.addItem(markAllSeenItem)

        return menu
    }

    @objc public func openCurrentConversation() {
        guard !isBootstrapping else { return }
        showMainWindow()
        mainWindow?.windowState.dismissOverlay()
    }

    @objc public func openNewChat() {
        guard !isBootstrapping else { return }
        showMainWindow()
        mainWindow?.conversationManager.createConversation()
        SoundManager.shared.play(.newConversation)
        if let id = mainWindow?.conversationManager.activeConversationId {
            mainWindow?.windowState.selection = .conversation(id)
        } else {
            // Draft mode — no activeConversationId yet, but still dismiss
            // any visible panel so the user sees the new empty chat.
            mainWindow?.windowState.selection = nil
        }
        UserDefaults.standard.set(false, forKey: "sidebarExpanded")
    }

    @objc func activateChatSearch() {
        NotificationCenter.default.post(name: .activateChatSearch, object: mainWindow?.conversationManager.activeConversationId)
    }

    @objc func openAppCollection() {
        guard !isBootstrapping else { return }
        showMainWindow()
        mainWindow?.windowState.selection = .panel(.apps)
    }

    @objc public func checkForUpdates() {
        // Docker/managed topologies: always navigate to Settings > General
        // where the Software Update card lives and auto-loads releases.
        // Sparkle is only relevant for local topology.
        let assistants = LockfileAssistant.loadAll()
        let connectedId = UserDefaults.standard.string(forKey: "connectedAssistantId")
        if let id = connectedId,
           let assistant = assistants.first(where: { $0.assistantId == id }),
           assistant.isDocker || assistant.isManaged {
            showSettingsTab("General")
            return
        }
        // Local topology: use Sparkle
        updateManager.checkForUpdates()
    }

    @objc func openAppById(_ sender: NSMenuItem) {
        guard !isBootstrapping else { return }
        guard let info = sender.representedObject as? [String: String],
              let appId = info["id"] else { return }
        showMainWindow()
        let cachedApp = cachedApps.first(where: { $0.id == appId })
        let appName = cachedApp?.name ?? info["name"] ?? appId
        let storedIcon = info["icon"]
        let appIcon = cachedApp?.icon ?? (storedIcon?.isEmpty == false ? storedIcon : nil)
        mainWindow?.appListManager.recordAppOpen(id: appId, name: appName, icon: appIcon)
        Task { await AppsClient.openAppAndDispatchSurface(id: appId, connectionManager: connectionManager, eventStreamClient: eventStreamClient) }
    }

    @objc func toggleSkill(_ sender: NSMenuItem) {
        guard let name = sender.representedObject as? String else { return }
        if sender.state == .on {
            Task { await SkillsClient().disableSkill(name: name) }
        } else {
            Task { await SkillsClient().enableSkill(name: name) }
        }
        refreshSkillsCache()
    }

    func refreshAppsCache() {
        refreshAppsTask?.cancel()
        refreshAppsTask = Task {
            let response = await AppsClient().fetchAppsList()
            guard let response, response.success else { return }
            self.cachedApps = response.apps
            let daemonItems = response.apps.map {
                AppListManager.AppItem_Daemon(
                    id: $0.id, name: $0.name, description: $0.description,
                    icon: $0.icon, appType: nil, createdAt: $0.createdAt
                )
            }
            self.mainWindow?.appListManager.syncFromDaemon(daemonItems)
        }
    }

    @objc public func sendFeedback() {
        // Defer window creation until after the status menu finishes dismissing,
        // otherwise macOS can swallow the makeKeyAndOrderFront during menu teardown.
        DispatchQueue.main.async { [weak self] in
            self?.showLogReportWindow()
        }
    }

    @objc func sendCurrentConversationFeedback() {
        guard let conversation = mainWindow?.conversationManager.activeConversation,
              let conversationId = conversation.conversationId else { return }

        // Defer window creation until after the status menu finishes dismissing,
        // otherwise macOS can swallow the makeKeyAndOrderFront during menu teardown.
        DispatchQueue.main.async { [weak self] in
            self?.showLogReportWindow(scope: .conversation(conversationId: conversationId, conversationTitle: conversation.title))
        }
    }

    func showLogReportWindow(scope: LogExportScope = .global, reason: LogReportReason? = nil) {
        // If the window is already showing, just bring it forward.
        if let existing = logReportWindow, existing.isVisible {
            existing.makeKeyAndOrderFront(nil)
            NSApp.activate(ignoringOtherApps: true)
            return
        }

        let dismiss: () -> Void = { [weak self] in
            self?.dismissLogReportWindow()
        }

        let view = LogReportFormView(
            authManager: authManager,
            initialReason: reason,
            onSend: { [weak self] formData in
                var formData = formData
                formData.scope = scope
                do {
                    try await LogExporter.sendFeedback(formData: formData)
                    self?.dismissLogReportWindow()
                    self?.mainWindow?.windowState.showToast(message: "Feedback sent", style: .success)
                } catch {
                    let event = Event(level: .error)
                    event.message = SentryMessage(formatted: "Feedback submission failed: \(error.localizedDescription)")
                    event.tags = [
                        "source": "feedback_submission",
                        "feedback_classification": LogExporter.feedbackClassification(for: formData.reason),
                    ]
                    event.extra = [
                        "error_type": String(describing: type(of: error)),
                        "error_description": error.localizedDescription,
                        "included_logs": formData.includeLogs,
                    ]
                    MetricKitManager.captureSentryEvent(event)

                    self?.dismissLogReportWindow()
                    self?.mainWindow?.windowState.showToast(
                        message: "Could not send feedback: \(error.localizedDescription)",
                        style: .error
                    )
                }
            },
            onCancel: dismiss
        )

        let hostingController = NSHostingController(rootView: view)
        let window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 480, height: 420),
            styleMask: [.titled, .closable],
            backing: .buffered,
            defer: false
        )
        window.contentViewController = hostingController
        switch scope {
        case .global:
            window.title = "Share Feedback"
        case .conversation:
            window.title = "Share Feedback"
        }
        window.backgroundColor = NSColor(VColor.surfaceOverlay)
        window.isReleasedWhenClosed = false
        window.center()

        logReportWindowObserver = NotificationCenter.default.addObserver(
            forName: NSWindow.willCloseNotification,
            object: window,
            queue: .main
        ) { [weak self] _ in
            MainActor.assumeIsolated {
                self?.handleLogReportWindowWillClose()
            }
        }

        logReportWindow = window

        // Switch to .regular activation policy first so the app can own key focus,
        // then order the window front and activate. The second async ensures the
        // policy change has taken effect before we try to grab focus.
        NSApp.activateAsDockAppIfNeeded()
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)

        // Belt-and-suspenders: re-activate after a run-loop tick so macOS respects
        // the policy switch that just happened above. Check logReportWindow to
        // avoid resurrecting a window that was closed during the async gap.
        DispatchQueue.main.async { [weak self] in
            guard let window = self?.logReportWindow, window.isVisible else { return }
            window.makeKeyAndOrderFront(nil)
            NSApp.activate(ignoringOtherApps: true)
        }
    }

    private func dismissLogReportWindow() {
        if let observer = logReportWindowObserver {
            NotificationCenter.default.removeObserver(observer)
            logReportWindowObserver = nil
        }
        let closingWindow = logReportWindow
        logReportWindow?.close()
        logReportWindow = nil
        revertActivationPolicyIfNoWindows(excluding: closingWindow)
    }

    private func handleLogReportWindowWillClose() {
        if let observer = logReportWindowObserver {
            NotificationCenter.default.removeObserver(observer)
            logReportWindowObserver = nil
        }
        let closingWindow = logReportWindow
        logReportWindow = nil
        revertActivationPolicyIfNoWindows(excluding: closingWindow)
    }

    func refreshSkillsCache() {
        refreshSkillsTask?.cancel()
        refreshSkillsTask = Task {
            let response = await SkillsClient().fetchSkillsList()
            guard let response else { return }
            self.cachedSkills = response.skills
        }
    }

    #if DEBUG
    @objc func showComponentGallery() {
        if galleryWindow == nil { galleryWindow = ComponentGalleryWindow() }
        galleryWindow?.show()
    }
    #endif
}
