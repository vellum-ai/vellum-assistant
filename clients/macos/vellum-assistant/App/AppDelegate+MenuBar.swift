import AppKit
import VellumAssistantShared
import SwiftUI
import os

private let log = Logger(subsystem: Bundle.main.bundleIdentifier ?? "com.vellum.vellum-assistant", category: "AppDelegate+MenuBar")

extension AppDelegate {

    // MARK: - Menu Bar

    func setupMenuBar() {
        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.squareLength)
        if let button = statusItem.button {
            configureMenuBarIcon(button)
            button.action = #selector(statusBarButtonClicked(_:))
            button.target = self
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

        let fileMenuItem = NSMenuItem(title: "File", action: nil, keyEquivalent: "")
        fileMenuItem.submenu = fileMenu
        mainMenu.insertItem(fileMenuItem, at: 1)
    }

    func setupViewMenu() {
        guard let mainMenu = NSApp.mainMenu else { return }

        let viewMenu = NSMenu(title: "View")

        let zoomInItem = NSMenuItem(title: "Zoom In", action: #selector(handleZoomIn), keyEquivalent: "=")
        zoomInItem.keyEquivalentModifierMask = .command
        zoomInItem.target = self
        viewMenu.addItem(zoomInItem)

        let zoomOutItem = NSMenuItem(title: "Zoom Out", action: #selector(handleZoomOut), keyEquivalent: "-")
        zoomOutItem.keyEquivalentModifierMask = .command
        zoomOutItem.target = self
        viewMenu.addItem(zoomOutItem)

        let resetItem = NSMenuItem(title: "Actual Size", action: #selector(handleZoomReset), keyEquivalent: "0")
        resetItem.keyEquivalentModifierMask = .command
        resetItem.target = self
        viewMenu.addItem(resetItem)

        let viewMenuItem = NSMenuItem(title: "View", action: nil, keyEquivalent: "")
        viewMenuItem.submenu = viewMenu
        mainMenu.addItem(viewMenuItem)
    }

    @objc func handleZoomIn() { zoomManager.zoomIn() }
    @objc func handleZoomOut() { zoomManager.zoomOut() }
    @objc func handleZoomReset() { zoomManager.resetZoom() }

    func configureMenuBarIcon(_ button: NSStatusBarButton) {
        let iconSize: CGFloat = 18
        let dotSize: CGFloat = 6
        let dotPadding: CGFloat = 0.5

        let appIcon = ResourceBundle.bundle.image(forResource: "MenuBarIcon")
            ?? NSImage(named: "MenuBarIcon")
            ?? NSApp.applicationIconImage
        guard let appIcon else {
            button.image = NSImage(systemSymbolName: "sparkles", accessibilityDescription: "Vellum")
            return
        }

        let status = currentAssistantStatus
        let dotColor = status.statusColor

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
        dotColor.setFill()
        NSBezierPath(ovalIn: dotRect).fill()
        composited.unlockFocus()
        composited.isTemplate = false
        button.image = composited
    }

    var currentAssistantStatus: AssistantStatus {
        guard let viewModel = mainWindow?.threadManager.activeViewModel else { return .idle }
        if let error = viewModel.errorText { return .error(error) }
        if viewModel.isThinking { return .thinking }
        return .idle
    }

    @objc func statusBarButtonClicked(_ sender: NSStatusBarButton) {
        showStatusMenu()
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

    @objc func openCurrentThread() {
        showMainWindow()
    }

    @objc func openNewChat() {
        showMainWindow()
        mainWindow?.threadManager.createThread()
        UserDefaults.standard.set(false, forKey: "sidebarOpen")
    }

    @objc func openAppCollection() {
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
        guard let info = sender.representedObject as? [String: String],
              let appId = info["id"] else { return }
        showMainWindow()
        let cachedApp = cachedApps.first(where: { $0.id == appId })
        let appName = cachedApp?.name ?? info["name"] ?? appId
        let storedIcon = info["icon"]
        let appIcon = cachedApp?.icon ?? (storedIcon?.isEmpty == false ? storedIcon : nil)
        mainWindow?.appListManager.recordAppOpen(id: appId, name: appName, icon: appIcon)
        try? daemonClient.sendAppOpen(appId: appId)
    }

    @objc func toggleSkill(_ sender: NSMenuItem) {
        guard let name = sender.representedObject as? String else { return }
        if sender.state == .on {
            try? daemonClient.disableSkill(name)
        } else {
            try? daemonClient.enableSkill(name)
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
                    return
                }
            }
        }
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
