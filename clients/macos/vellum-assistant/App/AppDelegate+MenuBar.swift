import AppKit
import VellumAssistantShared
import SwiftUI
import os

private let log = Logger(subsystem: Bundle.main.bundleIdentifier ?? "com.vellum.vellum-assistant", category: "AppDelegate+MenuBar")

extension Notification.Name {
    /// Posted when the user triggers Edit > Find (Cmd+F) from the menu bar.
    static let activateChatSearch = Notification.Name("activateChatSearch")
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

        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.squareLength)
        statusItem.autosaveName = "VellumMenuBar"
        statusItem.isVisible = true
        if let button = statusItem.button {
            configureMenuBarIcon(button)
            button.action = #selector(statusBarButtonClicked(_:))
            button.target = self
            button.sendAction(on: [.leftMouseUp, .rightMouseUp])
        }

        rebindConnectionStatusObserver()
    }

    /// (Re-)subscribe to `daemonClient.$isConnected` so the menu bar icon
    /// tracks the current daemon client. Called from `setupMenuBar()` and
    /// again from `setupDaemonClient()` after transport reconfiguration.
    func rebindConnectionStatusObserver() {
        connectionStatusCancellable?.cancel()
        connectionStatusCancellable = daemonClient.$isConnected
            .receive(on: RunLoop.main)
            .sink { [weak self] _ in
                self?.updateMenuBarIcon()
            }
    }

    func setupFileMenu() {
        guard let mainMenu = NSApp.mainMenu else { return }

        // Avoid duplicate File menus on logout/re-login cycles
        if mainMenu.indexOfItem(withTitle: "File") >= 0 { return }

        let fileMenu = NSMenu(title: "File")

        let newChatItem = NSMenuItem(title: "New Chat", action: #selector(openNewChat), keyEquivalent: "n")
        newChatItem.keyEquivalentModifierMask = .command
        newChatItem.target = self
        fileMenu.addItem(newChatItem)

        let markAllSeenItem = NSMenuItem(
            title: "Mark All Conversations as Seen",
            action: #selector(markAllConversationsSeen),
            keyEquivalent: "k"
        )
        markAllSeenItem.keyEquivalentModifierMask = [.command, .shift]
        markAllSeenItem.target = self
        fileMenu.addItem(markAllSeenItem)

        let fileMenuItem = NSMenuItem(title: "File", action: nil, keyEquivalent: "")
        fileMenuItem.submenu = fileMenu
        mainMenu.insertItem(fileMenuItem, at: 1)

        // Edit menu — provides Cmd+F "Find" so the shortcut works regardless of focus state.
        if mainMenu.indexOfItem(withTitle: "Edit") < 0 {
            let editMenu = NSMenu(title: "Edit")

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
            let bundle = ResourceBundle.bundle
            if let url = bundle.url(
                forResource: "icon-64",
                withExtension: "png",
                subdirectory: "Assets.xcassets/MenuBarIcon.imageset"
            ), let img = NSImage(contentsOf: url) {
                return img
            }
            return VIcon.sparkles.nsImage(size: 18)
                ?? NSImage()
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
        if !daemonClient.isConnected { return .disconnected }
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
           MacOSClientFeatureFlagManager.shared.isEnabled("quick_input_enabled") {
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
        let statusItem = NSMenuItem(title: status.menuTitle, action: nil, keyEquivalent: "")
        statusItem.isEnabled = false
        statusItem.image = status.statusIcon
        menu.addItem(statusItem)

        menu.addItem(NSMenuItem.separator())

        let currentConversationItem = NSMenuItem(title: "Current Conversation", action: #selector(openCurrentConversation), keyEquivalent: "")
        currentConversationItem.target = self
        currentConversationItem.image = VIcon.messageSquare.nsImage
        menu.addItem(currentConversationItem)

        let newChatItem = NSMenuItem(title: "New Chat", action: #selector(openNewChat), keyEquivalent: "n")
        newChatItem.target = self
        newChatItem.image = VIcon.messageCirclePlus.nsImage
        menu.addItem(newChatItem)

        menu.addItem(NSMenuItem.separator())

        let updateItem = NSMenuItem(title: "Check for Updates...", action: #selector(checkForUpdates), keyEquivalent: "")
        updateItem.target = self
        updateItem.isEnabled = updateManager.canCheckForUpdates
        updateItem.image = VIcon.circleArrowDown.nsImage
        menu.addItem(updateItem)

        if MacOSClientFeatureFlagManager.shared.isEnabled("developer_menu_items_enabled") {
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
        settingsItem.image = VIcon.settings.nsImage
        menu.addItem(settingsItem)

        let restartItem = NSMenuItem(title: "Restart", action: #selector(performRestart), keyEquivalent: "")
        restartItem.target = self
        restartItem.image = VIcon.refreshCw.nsImage
        menu.addItem(restartItem)

        let quitItem = NSMenuItem(title: "Quit", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        quitItem.image = VIcon.power.nsImage
        menu.addItem(quitItem)

        // Temporarily assign the menu to the status item so macOS handles
        // positioning natively (directly below the icon, left-aligned).
        // performClick is synchronous for menus — it blocks until the menu
        // closes — so we can nil it out immediately after to re-enable
        // custom click handling in statusBarButtonClicked.
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

        let newChatItem = NSMenuItem(title: "New Chat", action: #selector(openNewChat), keyEquivalent: "")
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

    @objc func openCurrentConversation() {
        guard !isBootstrapping else { return }
        showMainWindow()
    }

    @objc func openNewChat() {
        guard !isBootstrapping else { return }
        showMainWindow()
        mainWindow?.conversationManager.createConversation()
        if let id = mainWindow?.conversationManager.activeConversationId {
            mainWindow?.windowState.selection = .conversation(id)
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

    @objc func checkForUpdates() {
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
        Task { await AppsClient.openAppAndDispatchSurface(id: appId, daemonClient: daemonClient) }
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

    @objc public func sendLogsToSentry() {
        // Defer window creation until after the status menu finishes dismissing,
        // otherwise macOS can swallow the makeKeyAndOrderFront during menu teardown.
        DispatchQueue.main.async { [weak self] in
            self?.showLogReportWindow()
        }
    }

    @objc func sendCurrentConversationLogsToSentry() {
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
                self?.dismissLogReportWindow()
                var formData = formData
                formData.scope = scope
                LogExporter.sendLogsToSentry(formData: formData)
            },
            onCancel: dismiss
        )

        let hostingController = NSHostingController(rootView: view)
        let window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 480, height: 680),
            styleMask: [.titled, .closable],
            backing: .buffered,
            defer: false
        )
        window.contentViewController = hostingController
        switch scope {
        case .global:
            window.title = "Send Logs to Vellum"
        case .conversation:
            window.title = "Send Logs for Conversation"
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
