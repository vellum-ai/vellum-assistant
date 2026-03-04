import AppKit
import VellumAssistantShared
import SwiftUI
import os

private let log = Logger(subsystem: Bundle.main.bundleIdentifier ?? "com.vellum.vellum-assistant", category: "AppDelegate+MenuBar")

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
            action: #selector(markAllThreadsSeen),
            keyEquivalent: "k"
        )
        markAllSeenItem.keyEquivalentModifierMask = [.command, .shift]
        markAllSeenItem.target = self
        fileMenu.addItem(markAllSeenItem)

        fileMenu.addItem(NSMenuItem.separator())

        let exportLogsItem = NSMenuItem(
            title: "Export Logs...",
            action: #selector(exportAssistantLogs),
            keyEquivalent: ""
        )
        exportLogsItem.target = self
        fileMenu.addItem(exportLogsItem)

        let fileMenuItem = NSMenuItem(title: "File", action: nil, keyEquivalent: "")
        fileMenuItem.submenu = fileMenu
        mainMenu.insertItem(fileMenuItem, at: 1)
    }

    func setupViewMenu() {
        guard let mainMenu = NSApp.mainMenu else { return }
        let managedZoomMenuTag = 9_401

        let viewMenu: NSMenu
        let existingIndex = mainMenu.indexOfItem(withTitle: "View")
        if existingIndex >= 0,
           let existingItem = mainMenu.item(at: existingIndex) {
            if let existingMenu = existingItem.submenu {
                viewMenu = existingMenu
            } else {
                let newMenu = NSMenu(title: "View")
                existingItem.submenu = newMenu
                viewMenu = newMenu
            }
        } else {
            let newMenu = NSMenu(title: "View")
            let viewMenuItem = NSMenuItem(title: "View", action: nil, keyEquivalent: "")
            viewMenuItem.submenu = newMenu
            mainMenu.addItem(viewMenuItem)
            viewMenu = newMenu
        }

        // Preserve non-managed items already provided by AppKit/SwiftUI,
        // while making this setup idempotent across reconfiguration cycles.
        let preservedItems = viewMenu.items.filter { item in
            item.tag != managedZoomMenuTag
        }
        viewMenu.removeAllItems()

        // Conversation Text Zoom: Cmd +, Cmd -, Cmd 0
        let convZoomInItem = NSMenuItem(
            title: "Conversation Zoom In",
            action: #selector(handleConversationZoomIn),
            keyEquivalent: "+"
        )
        convZoomInItem.keyEquivalentModifierMask = .command
        convZoomInItem.target = self
        convZoomInItem.tag = managedZoomMenuTag
        viewMenu.addItem(convZoomInItem)

        let convZoomOutItem = NSMenuItem(
            title: "Conversation Zoom Out",
            action: #selector(handleConversationZoomOut),
            keyEquivalent: "-"
        )
        convZoomOutItem.keyEquivalentModifierMask = .command
        convZoomOutItem.target = self
        convZoomOutItem.tag = managedZoomMenuTag
        viewMenu.addItem(convZoomOutItem)

        let convResetItem = NSMenuItem(
            title: "Conversation Actual Size",
            action: #selector(handleConversationZoomReset),
            keyEquivalent: "0"
        )
        convResetItem.keyEquivalentModifierMask = .command
        convResetItem.target = self
        convResetItem.tag = managedZoomMenuTag
        viewMenu.addItem(convResetItem)

        let zoomGroupSeparator = NSMenuItem.separator()
        zoomGroupSeparator.tag = managedZoomMenuTag
        viewMenu.addItem(zoomGroupSeparator)

        // Window Zoom: Option+Cmd +, Option+Cmd -, Option+Cmd 0
        let winZoomInItem = NSMenuItem(
            title: "Window Zoom In",
            action: #selector(handleWindowZoomIn),
            keyEquivalent: "+"
        )
        winZoomInItem.keyEquivalentModifierMask = [.command, .option]
        winZoomInItem.target = self
        winZoomInItem.tag = managedZoomMenuTag
        viewMenu.addItem(winZoomInItem)

        let winZoomOutItem = NSMenuItem(
            title: "Window Zoom Out",
            action: #selector(handleWindowZoomOut),
            keyEquivalent: "-"
        )
        winZoomOutItem.keyEquivalentModifierMask = [.command, .option]
        winZoomOutItem.target = self
        winZoomOutItem.tag = managedZoomMenuTag
        viewMenu.addItem(winZoomOutItem)

        let winResetItem = NSMenuItem(
            title: "Window Actual Size",
            action: #selector(handleWindowZoomReset),
            keyEquivalent: "0"
        )
        winResetItem.keyEquivalentModifierMask = [.command, .option]
        winResetItem.target = self
        winResetItem.tag = managedZoomMenuTag
        viewMenu.addItem(winResetItem)

        if !preservedItems.isEmpty {
            let preservedSeparator = NSMenuItem.separator()
            preservedSeparator.tag = managedZoomMenuTag
            viewMenu.addItem(preservedSeparator)
            for item in preservedItems {
                viewMenu.addItem(item)
            }
        }
    }

    // MARK: - Zoom Intent Routing

    func routeZoomIntent(_ intent: VZoomCommandIntent) {
        switch intent {
        case .windowZoomIn:
            zoomManager.zoomIn()
        case .windowZoomOut:
            zoomManager.zoomOut()
        case .windowZoomReset:
            zoomManager.resetZoom()
        case .conversationZoomIn:
            conversationZoomManager.zoomIn()
        case .conversationZoomOut:
            conversationZoomManager.zoomOut()
        case .conversationZoomReset:
            conversationZoomManager.resetZoom()
        }
    }

    @objc public func handleConversationZoomIn() { routeZoomIntent(.conversationZoomIn) }
    @objc public func handleConversationZoomOut() { routeZoomIntent(.conversationZoomOut) }
    @objc public func handleConversationZoomReset() { routeZoomIntent(.conversationZoomReset) }
    @objc public func handleWindowZoomIn() { routeZoomIntent(.windowZoomIn) }
    @objc public func handleWindowZoomOut() { routeZoomIntent(.windowZoomOut) }
    @objc public func handleWindowZoomReset() { routeZoomIntent(.windowZoomReset) }

    // MARK: - Menu Item Validation

    /// Disables conversation zoom shortcuts when no conversation is visible,
    /// preventing accidental side effects in non-chat panels.
    @objc func validateMenuItem(_ menuItem: NSMenuItem) -> Bool {
        guard let action = menuItem.action else { return true }
        let conversationZoomSelectors: Set<Selector> = [
            #selector(handleConversationZoomIn),
            #selector(handleConversationZoomOut),
            #selector(handleConversationZoomReset),
        ]
        if conversationZoomSelectors.contains(action) {
            return mainWindow?.windowState.isConversationVisible ?? false
        }
        if action == #selector(markAllThreadsSeen) {
            return (mainWindow?.threadManager.unseenVisibleConversationCount ?? 0) > 0
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
            return NSImage(systemSymbolName: "sparkles", accessibilityDescription: "Vellum")
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
        NSColor.black.withAlphaComponent(0.5).setFill()
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
        guard let viewModel = mainWindow?.threadManager.activeViewModel else { return .idle }
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
            showStatusMenu()
        } else {
            toggleQuickInput()
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

        let currentThreadItem = NSMenuItem(title: "Current Thread", action: #selector(openCurrentThread), keyEquivalent: "")
        currentThreadItem.target = self
        currentThreadItem.image = NSImage(systemSymbolName: "message", accessibilityDescription: nil)
        menu.addItem(currentThreadItem)

        let newChatItem = NSMenuItem(title: "New Chat", action: #selector(openNewChat), keyEquivalent: "n")
        newChatItem.target = self
        newChatItem.image = NSImage(systemSymbolName: "plus.message", accessibilityDescription: nil)
        menu.addItem(newChatItem)

        // My Apps submenu
        let myAppsItem = NSMenuItem(title: "My Apps", action: nil, keyEquivalent: "")
        myAppsItem.image = NSImage(systemSymbolName: "square.grid.2x2", accessibilityDescription: nil)
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
        skillsItem.image = NSImage(systemSymbolName: "puzzlepiece.extension", accessibilityDescription: nil)
        let skillsSubmenu = NSMenu(title: "Skills")

        let enabledSkills = cachedSkills.filter { $0.state == "enabled" }
        let disabledSkills = cachedSkills.filter { $0.state != "enabled" }

        for skill in enabledSkills {
            let emoji = skill.emoji ?? "\u{1F527}"
            let item = NSMenuItem(title: "\(emoji) \(skill.name)", action: #selector(toggleSkill(_:)), keyEquivalent: "")
            item.target = self
            item.state = .on
            item.representedObject = skill.name
            skillsSubmenu.addItem(item)
        }

        for skill in disabledSkills {
            let emoji = skill.emoji ?? "\u{1F527}"
            let item = NSMenuItem(title: "\(emoji) \(skill.name)", action: #selector(toggleSkill(_:)), keyEquivalent: "")
            item.target = self
            item.state = .off
            item.representedObject = skill.name
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

        let settingsItem = NSMenuItem(title: "Settings...", action: #selector(showSettingsWindow(_:)), keyEquivalent: ",")
        settingsItem.target = self
        settingsItem.image = NSImage(systemSymbolName: "gear", accessibilityDescription: nil)
        menu.addItem(settingsItem)

        menu.addItem(NSMenuItem.separator())

        // Ride Shotgun submenu
        let rideShotgunItem = NSMenuItem(title: "Ride Shotgun", action: nil, keyEquivalent: "")
        rideShotgunItem.image = NSImage(systemSymbolName: "binoculars", accessibilityDescription: nil)
        let rideShotgunSubmenu = NSMenu(title: "Ride Shotgun")

        let observeItem = NSMenuItem(title: "Observe (3 min)", action: #selector(startRideShotgunObserve), keyEquivalent: "")
        observeItem.target = self
        observeItem.isEnabled = ambientAgent.currentSession == nil
        rideShotgunSubmenu.addItem(observeItem)

        let learnItem = NSMenuItem(title: "Learn (5 min)", action: #selector(startRideShotgunLearn), keyEquivalent: "")
        learnItem.target = self
        learnItem.isEnabled = ambientAgent.currentSession == nil
        rideShotgunSubmenu.addItem(learnItem)

        if ambientAgent.currentSession != nil {
            rideShotgunSubmenu.addItem(NSMenuItem.separator())
            let stopItem = NSMenuItem(title: "Stop & Save", action: #selector(stopRideShotgun), keyEquivalent: "")
            stopItem.target = self
            rideShotgunSubmenu.addItem(stopItem)
        }

        rideShotgunItem.submenu = rideShotgunSubmenu
        menu.addItem(rideShotgunItem)

        menu.addItem(NSMenuItem.separator())

        let updateItem = NSMenuItem(title: "Check for Updates...", action: #selector(checkForUpdates), keyEquivalent: "")
        updateItem.target = self
        updateItem.isEnabled = updateManager.canCheckForUpdates
        updateItem.image = NSImage(systemSymbolName: "arrow.down.circle", accessibilityDescription: nil)
        menu.addItem(updateItem)

        let onboardingItem = NSMenuItem(title: "Replay Onboarding", action: #selector(replayOnboarding), keyEquivalent: "")
        onboardingItem.target = self
        menu.addItem(onboardingItem)

        #if DEBUG
        menu.addItem(NSMenuItem.separator())
        let galleryItem = NSMenuItem(title: "Component Gallery", action: #selector(showComponentGallery), keyEquivalent: "")
        galleryItem.target = self
        menu.addItem(galleryItem)
        #endif

        let exportLogsItem = NSMenuItem(title: "Export Logs...", action: #selector(exportAssistantLogs), keyEquivalent: "")
        exportLogsItem.target = self
        exportLogsItem.image = NSImage(systemSymbolName: "doc.zipper", accessibilityDescription: nil)
        menu.addItem(exportLogsItem)

        let restartItem = NSMenuItem(title: "Restart", action: #selector(performRestart), keyEquivalent: "")
        restartItem.target = self
        restartItem.image = NSImage(systemSymbolName: "arrow.clockwise", accessibilityDescription: nil)
        menu.addItem(restartItem)

        menu.addItem(NSMenuItem.separator())

        let logoutItem = NSMenuItem(title: "Sign Out", action: #selector(performLogout), keyEquivalent: "")
        logoutItem.target = self
        logoutItem.image = NSImage(systemSymbolName: "rectangle.portrait.and.arrow.right", accessibilityDescription: nil)
        menu.addItem(logoutItem)

        let quitItem = NSMenuItem(title: "Quit", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        quitItem.image = NSImage(systemSymbolName: "power", accessibilityDescription: nil)
        menu.addItem(quitItem)

        menu.popUp(positioning: nil, at: NSPoint(x: 0, y: button.bounds.height + 2), in: button)
    }

    @objc func markAllThreadsSeen() {
        guard let threadManager = mainWindow?.threadManager else { return }
        let markedIds = threadManager.markAllThreadsSeen()
        guard !markedIds.isEmpty else { return }
        let count = markedIds.count
        let toastId = mainWindow?.windowState.showToast(
            message: "Marked \(count) thread\(count == 1 ? "" : "s") as seen",
            style: .success,
            primaryAction: VToastAction(label: "Undo") { [weak self] in
                self?.mainWindow?.threadManager.restoreUnseen(threadIds: markedIds)
                self?.mainWindow?.windowState.dismissToast()
            },
            onDismiss: { [weak self] in
                self?.mainWindow?.threadManager.commitPendingSeenSignals()
            }
        )
        threadManager.schedulePendingSeenSignals { [weak self] in
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
            action: #selector(markAllThreadsSeen),
            keyEquivalent: ""
        )
        markAllSeenItem.target = self
        menu.addItem(markAllSeenItem)

        return menu
    }

    @objc func openCurrentThread() {
        guard !isBootstrapping else { return }
        showMainWindow()
    }

    @objc func openNewChat() {
        guard !isBootstrapping else { return }
        showMainWindow()
        mainWindow?.threadManager.enterDraftMode()
        UserDefaults.standard.set(false, forKey: "sidebarExpanded")
    }

    @objc func openAppCollection() {
        guard !isBootstrapping else { return }
        showMainWindow()
        mainWindow?.windowState.selection = .panel(.directory)
    }

    @objc func checkForUpdates() {
        updateManager.checkForUpdates()
    }

    @objc func showRideShotgunInvitation() {
        Task { @MainActor in
            await ambientAgent.showInvitation()
        }
    }

    @objc func startRideShotgunObserve() {
        ambientAgent.startRideShotgun(durationSeconds: 180)
    }

    @objc func startRideShotgunLearn() {
        let alert = NSAlert()
        alert.messageText = "Learn Session"
        alert.informativeText = "Enter the target domain to record:"
        alert.alertStyle = .informational
        alert.addButton(withTitle: "Start")
        alert.addButton(withTitle: "Cancel")

        let input = NSTextField(frame: NSRect(x: 0, y: 0, width: 260, height: 24))
        input.stringValue = "doordash.com"
        input.placeholderString = "example.com"
        alert.accessoryView = input
        alert.window.initialFirstResponder = input

        guard alert.runModal() == .alertFirstButtonReturn else { return }
        var domain = input.stringValue.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        // Strip URL scheme if user entered a full URL
        if let url = URL(string: domain), let host = url.host {
            domain = host
        } else if domain.hasPrefix("https://") {
            domain = String(domain.dropFirst("https://".count))
        } else if domain.hasPrefix("http://") {
            domain = String(domain.dropFirst("http://".count))
        }
        // Strip trailing slash/path
        if let slashIdx = domain.firstIndex(of: "/") {
            domain = String(domain[domain.startIndex..<slashIdx])
        }
        guard !domain.isEmpty else { return }

        ambientAgent.startLearnSession(targetDomain: domain, durationSeconds: 300)
    }

    @objc func stopRideShotgun() {
        ambientAgent.stopRideShotgunEarly()
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
                    self.cachedApps = response.apps
                    // Sync daemon apps into the sidebar list so pre-existing apps appear
                    let daemonItems = response.apps.map {
                        AppListManager.AppItem_Daemon(
                            id: $0.id, name: $0.name, description: $0.description,
                            icon: $0.icon, appType: nil, createdAt: $0.createdAt
                        )
                    }
                    self.mainWindow?.appListManager.syncFromDaemon(daemonItems)
                    return
                }
            }
        }
    }

    @objc func exportAssistantLogs() {
        LogExporter.exportLogs()
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
