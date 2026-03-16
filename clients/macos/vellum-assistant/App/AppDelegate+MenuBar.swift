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
            title: "Mark All Threads as Seen",
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

        let composited = NSImage(size: NSSize(width: iconSize, height: iconSize))
        composited.lockFocus()
        appIcon.draw(
            in: NSRect(x: 0, y: 0, width: iconSize, height: iconSize),
            from: NSRect(origin: .zero, size: appIcon.size),
            operation: .copy,
            fraction: 1.0
        )
        let dotX = iconSize - dotSize - dotPadding
        let dotY = dotPadding
        let dotRect = NSRect(x: dotX, y: dotY, width: dotSize, height: dotSize)
        NSColor(VColor.auxBlack).withAlphaComponent(0.5).setFill()
        NSBezierPath(ovalIn: dotRect.insetBy(dx: -0.5, dy: -0.5)).fill()
        dotColor.withAlphaComponent(dotAlpha).setFill()
        NSBezierPath(ovalIn: dotRect).fill()
        composited.unlockFocus()
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
        if event.type == .rightMouseUp || event.modifierFlags.contains(.control) {
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

        // My Apps submenu
        let myAppsItem = NSMenuItem(title: "My Apps", action: nil, keyEquivalent: "")
        myAppsItem.image = VIcon.layoutGrid.nsImage
        let appsSubmenu = NSMenu(title: "My Apps")

        let recentApps = Array(cachedApps.sorted { $0.createdAt > $1.createdAt }.prefix(5))
        for app in recentApps {
            let emoji = app.icon ?? "\u{1F4F1}"
            let item = NSMenuItem(title: "\(emoji) \(app.name)", action: #selector(openAppById(_:)), keyEquivalent: "")
            item.target = self
            item.representedObject = ["id": app.id, "name": app.name, "icon": app.icon ?? ""]
            appsSubmenu.addItem(item)
        }

        if !recentApps.isEmpty {
            appsSubmenu.addItem(NSMenuItem.separator())
        }

        let manageAppsItem = NSMenuItem(title: "Manage Apps...", action: #selector(openAppCollection), keyEquivalent: "")
        manageAppsItem.target = self
        appsSubmenu.addItem(manageAppsItem)

        myAppsItem.submenu = appsSubmenu
        menu.addItem(myAppsItem)

        // Skills submenu
        let skillsItem = NSMenuItem(title: "Skills", action: nil, keyEquivalent: "")
        skillsItem.image = VIcon.puzzle.nsImage
        let skillsSubmenu = NSMenu(title: "Skills")

        let enabledSkills = cachedSkills.filter { $0.state == "enabled" }
        let disabledSkills = cachedSkills.filter { $0.state != "enabled" }

        for skill in enabledSkills {
            let emoji = skill.emoji ?? "\u{1F527}"
            let item = NSMenuItem(title: "\(emoji) \(skill.name)", action: #selector(toggleSkill(_:)), keyEquivalent: "")
            item.target = self
            item.state = .on
            item.representedObject = skill.id
            skillsSubmenu.addItem(item)
        }

        for skill in disabledSkills {
            let emoji = skill.emoji ?? "\u{1F527}"
            let item = NSMenuItem(title: "\(emoji) \(skill.name)", action: #selector(toggleSkill(_:)), keyEquivalent: "")
            item.target = self
            item.state = .off
            item.representedObject = skill.id
            skillsSubmenu.addItem(item)
        }

        if !cachedSkills.isEmpty {
            skillsSubmenu.addItem(NSMenuItem.separator())
        }

        let manageSkillsItem = NSMenuItem(title: "Manage Skills...", action: #selector(showSettingsWindow(_:)), keyEquivalent: "")
        manageSkillsItem.target = self
        skillsSubmenu.addItem(manageSkillsItem)

        skillsItem.submenu = skillsSubmenu
        menu.addItem(skillsItem)

        menu.addItem(NSMenuItem.separator())

        let updateItem = NSMenuItem(title: "Check for Updates...", action: #selector(checkForUpdates), keyEquivalent: "")
        updateItem.target = self
        updateItem.isEnabled = updateManager.canCheckForUpdates
        updateItem.image = VIcon.circleArrowDown.nsImage
        menu.addItem(updateItem)

        let sendLogsItem = NSMenuItem(title: "Send Logs to Vellum", action: #selector(sendLogsToSentry), keyEquivalent: "")
        sendLogsItem.target = self
        sendLogsItem.image = VIcon.upload.nsImage
        menu.addItem(sendLogsItem)

        let sendConversationLogsItem = NSMenuItem(title: "Send Logs for Current Conversation", action: #selector(sendCurrentConversationLogsToSentry), keyEquivalent: "")
        sendConversationLogsItem.target = self
        sendConversationLogsItem.image = VIcon.upload.nsImage
        sendConversationLogsItem.isEnabled = mainWindow?.conversationManager.activeConversation?.conversationId != nil && !isCurrentAssistantManaged
        menu.addItem(sendConversationLogsItem)

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
        settingsItem.image = VIcon.settings.nsImage
        menu.addItem(settingsItem)

        let restartItem = NSMenuItem(title: "Restart", action: #selector(performRestart), keyEquivalent: "")
        restartItem.target = self
        restartItem.image = VIcon.refreshCw.nsImage
        menu.addItem(restartItem)

        let logoutItem = NSMenuItem(title: "Sign Out", action: #selector(performLogout), keyEquivalent: "")
        logoutItem.target = self
        logoutItem.image = VIcon.logOut.nsImage
        menu.addItem(logoutItem)

        let quitItem = NSMenuItem(title: "Quit", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        quitItem.image = VIcon.power.nsImage
        menu.addItem(quitItem)

        menu.popUp(positioning: nil, at: NSPoint(x: 0, y: button.bounds.height + 2), in: button)
    }

    @objc func markAllConversationsSeen() {
        guard let conversationManager = mainWindow?.conversationManager else { return }
        let markedIds = conversationManager.markAllConversationsSeen()
        guard !markedIds.isEmpty else { return }
        let count = markedIds.count
        let toastId = mainWindow?.windowState.showToast(
            message: "Marked \(count) thread\(count == 1 ? "" : "s") as seen",
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
            title: "Mark All Threads as Seen",
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
        do {
            try daemonClient.sendAppOpen(appId: appId)
        } catch {
            log.error("Failed to send app open for \(appId, privacy: .private): \(error)")
        }
    }

    @objc func toggleSkill(_ sender: NSMenuItem) {
        guard let name = sender.representedObject as? String else { return }
        if sender.state == .on {
            do {
                try daemonClient.disableSkill(name)
            } catch {
                log.error("Failed to disable skill \(name, privacy: .private): \(error)")
            }
        } else {
            do {
                try daemonClient.enableSkill(name)
            } catch {
                log.error("Failed to enable skill \(name, privacy: .private): \(error)")
            }
        }
        refreshSkillsCache()
    }

    func refreshAppsCache() {
        refreshAppsTask?.cancel()
        refreshAppsTask = Task {
            let stream = daemonClient.subscribe()
            do {
                try daemonClient.sendAppsList()
            } catch { return }
            for await message in stream {
                guard !Task.isCancelled else { return }
                if case .appsListResponse(let response) = message {
                    if response.success {
                        self.cachedApps = response.apps
                        let daemonItems = response.apps.map {
                            AppListManager.AppItem_Daemon(
                                id: $0.id, name: $0.name, description: $0.description,
                                icon: $0.icon, appType: nil, createdAt: $0.createdAt
                            )
                        }
                        self.mainWindow?.appListManager.syncFromDaemon(daemonItems)
                    }
                    return
                }
            }
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

    func showLogReportWindow(scope: LogExportScope = .global) {
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
        // Cancel any in-flight refresh so we don't consume a stale response.
        // The new task will send its own request and wait for the next response,
        // ensuring the cache always reflects the latest daemon state.
        refreshSkillsTask?.cancel()
        refreshSkillsTask = Task {
            let stream = daemonClient.subscribe()
            do {
                try daemonClient.send(SkillsListRequestMessage())
            } catch { return }
            for await message in stream {
                guard !Task.isCancelled else { return }
                if case .skillsListResponse(let response) = message {
                    self.cachedSkills = response.skills
                    return
                }
            }
        }
    }

    #if DEBUG
    @objc func showComponentGallery() {
        if galleryWindow == nil { galleryWindow = ComponentGalleryWindow() }
        galleryWindow?.show()
    }
    #endif
}
