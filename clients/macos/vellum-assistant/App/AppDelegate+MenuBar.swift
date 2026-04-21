import AppKit
@preconcurrency import Sentry
import SwiftUI
import VellumAssistantShared
import os

private let log = Logger(subsystem: Bundle.appBundleIdentifier, category: "AppDelegate+MenuBar")

extension Notification.Name {
    /// Posted when the user triggers Edit > Find (Cmd+F) from the menu bar.
    static let activateChatSearch = Notification.Name("activateChatSearch")
}

/// Paired snapshot of the two `GatewayConnectionManager` signals the menu-bar
/// observer cares about. Wrapping them in a single `Equatable` value lets the
/// single `observationStream` task wake on either change without needing a
/// second Task/cleanup site.
private struct ConnectionStatusSnapshot: Equatable, Sendable {
    let isConnected: Bool
    let isAuthFailed: Bool
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

        let markUnreadShortcut = UserDefaults.standard.string(forKey: "markConversationUnreadShortcut") ?? "cmd+shift+u"
        let markUnreadItem: NSMenuItem
        if markUnreadShortcut.isEmpty {
            markUnreadItem = NSMenuItem(title: "Mark Conversation as Unread", action: #selector(AppDelegate.markCurrentConversationUnread), keyEquivalent: "")
        } else {
            let (muModifiers, muKey) = ShortcutHelper.parseShortcut(markUnreadShortcut)
            markUnreadItem = NSMenuItem(title: "Mark Conversation as Unread", action: #selector(AppDelegate.markCurrentConversationUnread), keyEquivalent: muKey)
            markUnreadItem.keyEquivalentModifierMask = muModifiers
        }
        markUnreadItem.target = appDelegate
        markUnreadItem.tag = Self.injectedTag
        menu.insertItem(markUnreadItem, at: 2)
        appDelegate.markConversationUnreadMenuItem = markUnreadItem

        let separator = NSMenuItem.separator()
        separator.tag = Self.injectedTag
        menu.insertItem(separator, at: 3)
    }
}

extension AppDelegate {

    // MARK: - Menu Bar

    func setupMenuBar() {
        if statusItem != nil {
            statusDotLayer?.removeAllAnimations()
            statusDotLayer?.removeFromSuperlayer()
            statusDotLayer = nil
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

        // Read the multi-platform-assistant flag exactly once when the
        // status item is constructed. Flag changes require relaunch.
        multiAssistantSwitcherEnabled = featureFlagStore.isEnabled("multi-platform-assistant")
        if multiAssistantSwitcherEnabled {
            assistantSwitcherViewModel = makeAssistantSwitcherViewModel()
        } else {
            assistantSwitcherViewModel = nil
        }

        // Update menu bar icon when the assistant's avatar changes.
        if avatarChangeObserver == nil {
            avatarChangeObserver = NotificationCenter.default.addObserver(
                forName: AvatarAppearanceManager.avatarDidChangeNotification,
                object: nil,
                queue: .main
            ) { [weak self] _ in
                MainActor.assumeIsolated {
                    self?.cachedMenuBarAvatar = nil
                    self?.updateMenuBarIcon()
                }
            }
        }
    }

    /// (Re-)subscribe to `connectionManager.isConnected` so the menu bar icon
    /// tracks the current daemon client. Called from `setupMenuBar()` and
    /// again from `setupGatewayConnectionManager()` after transport reconfiguration.
    func rebindConnectionStatusObserver() {
        connectionStatusTask?.cancel()
        connectionStatusTask = Task { @MainActor [weak self] in
            // Observe `isConnected` and `isAuthFailed` together so the menu bar
            // icon reacts to either signal changing. Both are plain `public var`
            // properties on the `@Observable @MainActor` GCM, so reading them
            // inside the closure registers dependency tracking on each.
            for await _ in observationStream({ [weak self] in
                ConnectionStatusSnapshot(
                    isConnected: self?.connectionManager.isConnected ?? false,
                    isAuthFailed: self?.connectionManager.isAuthFailed ?? false
                )
            }) {
                guard let self, !Task.isCancelled else { break }
                self.updateMenuBarIcon()
            }
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
        updateMarkConversationUnreadMenuItemShortcut()
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

    /// Updates the File > Mark Conversation as Unread menu item's key equivalent
    /// to match the current `markConversationUnreadShortcut` preference.
    func updateMarkConversationUnreadMenuItemShortcut() {
        guard let item = markConversationUnreadMenuItem else { return }
        let shortcut = UserDefaults.standard.string(forKey: "markConversationUnreadShortcut") ?? "cmd+shift+u"
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
        if action == #selector(markCurrentConversationUnread) {
            return canMarkCurrentConversationUnread()
        }
        return true
    }

    /// Returns whether the mark-as-unread action is currently executable.
    /// Shared by `validateMenuItem(_:)` and the keyboard-shortcut monitor so
    /// both gates stay in sync and the shortcut falls through to the responder
    /// chain when the action cannot run.
    func canMarkCurrentConversationUnread() -> Bool {
        guard let conversationManager = mainWindow?.conversationManager,
              let activeId = conversationManager.selectionStore.activeConversationId,
              let idx = conversationManager.listStore.conversations.firstIndex(where: { $0.id == activeId })
        else { return false }
        return conversationManager.listStore.canMarkConversationUnread(conversationId: activeId, at: idx)
    }

    /// Builds the status item tooltip, appending PTT key info when enabled.
    /// Reads the precomputed `cachedDisplayName` so this runs on every
    /// connection-status change without recomputing the display string.
    private func menuBarTooltip() -> String {
        let activator = PTTActivator.cached
        let name = Self.appName
        guard activator.kind != .none else { return name }
        return "\(name) — hold \(PTTActivator.cachedDisplayName) to talk"
    }

    func configureMenuBarIcon(_ button: NSStatusBarButton) {
        button.toolTip = menuBarTooltip()
        let iconSize: CGFloat = 18
        let dotSize: CGFloat = 6
        let dotPadding: CGFloat = 0.5

        let appIcon: NSImage = cachedMenuBarAvatar ?? {
            let avatarManager = AvatarAppearanceManager.shared
            let avatar = avatarManager.customAvatarImage
                ?? avatarManager.fullAvatarImage

            let size = iconSize
            let square = AvatarAppearanceManager.resizedImage(avatar, to: size)
            let circular = NSImage(size: NSSize(width: size, height: size), flipped: false) { rect in
                NSBezierPath(ovalIn: rect).addClip()
                square.draw(in: rect, from: NSRect(origin: .zero, size: square.size),
                            operation: .copy, fraction: 1.0)
                return true
            }
            cachedMenuBarAvatar = circular
            return circular
        }()

        // Set the button image to the avatar only — the status dot is
        // rendered by a separate CAShapeLayer so pulse animation can run
        // on Core Animation's render-server thread without touching the
        // main thread or triggering implicit CA::Transactions.
        appIcon.isTemplate = false
        button.image = appIcon

        let status = currentAssistantStatus
        let dotColor = status.statusColor

        // Ensure the button is layer-backed so we can add sublayers.
        button.wantsLayer = true
        guard let buttonLayer = button.layer else { return }

        // Create the dot layer on first use.
        if statusDotLayer == nil {
            let dot = CAShapeLayer()
            dot.bounds = CGRect(x: 0, y: 0, width: dotSize, height: dotSize)
            dot.path = CGPath(ellipseIn: CGRect(x: 0, y: 0, width: dotSize, height: dotSize), transform: nil)
            buttonLayer.addSublayer(dot)
            statusDotLayer = dot
        }

        if let dot = statusDotLayer {
            // The button is wider than the 18×18 icon (macOS adds horizontal
            // padding). Compute where the image actually sits so the dot stays
            // anchored to the avatar regardless of button size / scale factor.
            let btnSize = button.bounds.size
            let imgOriginX = (btnSize.width - iconSize) / 2
            let imgOriginY = (btnSize.height - iconSize) / 2

            // CAShapeLayer.position is center-based; Y=0 is at the bottom
            // (layer is not flipped).
            let dotX = imgOriginX + iconSize - dotSize / 2 - dotPadding
            let dotY = imgOriginY + dotSize / 2 + dotPadding
            dot.position = CGPoint(x: dotX, y: dotY)

            // Dark outline ring behind the dot for contrast.
            dot.strokeColor = NSColor(VColor.auxBlack).withAlphaComponent(0.5).cgColor
            dot.lineWidth = 1.0
            dot.fillColor = dotColor.cgColor
        }

        managePulseAnimation(for: status)
    }

    /// Adds or removes a Core Animation opacity pulse on the status dot layer.
    /// The animation runs entirely on CA's render-server thread, so it never
    /// touches the main thread or contends with CA::Transaction locks held
    /// during status-bar menu display.
    private func managePulseAnimation(for status: AssistantStatus) {
        guard let dot = statusDotLayer else { return }
        if status.shouldPulse {
            guard dot.animation(forKey: "pulse") == nil else { return }
            let pulse = CABasicAnimation(keyPath: "opacity")
            pulse.fromValue = 1.0
            pulse.toValue = 0.3
            pulse.duration = 0.7
            pulse.autoreverses = true
            pulse.repeatCount = .infinity
            pulse.timingFunction = CAMediaTimingFunction(name: .easeInEaseOut)
            dot.add(pulse, forKey: "pulse")
        } else {
            dot.removeAnimation(forKey: "pulse")
            dot.opacity = 1.0
        }
    }

    var currentAssistantStatus: AssistantStatus {
        if connectionManager.isAuthFailed { return .authFailed }
        if !connectionManager.isConnected { return .disconnected }
        guard let viewModel = mainWindow?.conversationManager.activeViewModel else { return .idle }
        if viewModel.errorText != nil { return .error }
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
        let name = AssistantDisplayName.resolve(IdentityInfo.current?.name)
        let statusItem = NSMenuItem(title: status.menuTitle(assistantName: name), action: nil, keyEquivalent: "")
        statusItem.isEnabled = false
        statusItem.image = status.statusIcon
        menu.addItem(statusItem)

        // During onboarding, only show the status line and Quit to prevent
        // users from bypassing the onboarding flow via Settings or conversations.
        // The Re-pair item must respect this policy too: calling forceReBootstrap()
        // while onboarding's credential flow is in progress would race it.
        if onboardingWindow == nil {
            menu.addItem(NSMenuItem.separator())

            if currentAssistantStatus == .authFailed {
                let item = NSMenuItem(
                    title: "Re-pair \(name)",
                    action: #selector(rePairAssistant),
                    keyEquivalent: ""
                )
                item.target = self
                item.image = VIcon.refreshCw.nsImage(size: 16)
                menu.addItem(item)
                menu.addItem(.separator())
            }

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

                let preChatItem = NSMenuItem(title: "Preview PreChat", action: #selector(showPreChatPreview), keyEquivalent: "")
                preChatItem.target = self
                menu.addItem(preChatItem)

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

            let soundsEnabled = SoundManager.shared.config.globalEnabled
            let muteTitle = soundsEnabled ? "Mute Sound Effects" : "Unmute Sound Effects"
            let muteItem = NSMenuItem(title: muteTitle, action: #selector(toggleSoundEffectsMute), keyEquivalent: "")
            muteItem.target = self
            muteItem.image = VIcon.volume2.nsImage(size: 16)
            menu.addItem(muteItem)

            menu.addItem(NSMenuItem.separator())

            let feedbackItem = NSMenuItem(title: "Share Feedback", action: #selector(sendFeedback), keyEquivalent: "")
            feedbackItem.target = self
            feedbackItem.image = VIcon.messageCircle.nsImage(size: 16)
            menu.addItem(feedbackItem)
        }

        if multiAssistantSwitcherEnabled, onboardingWindow == nil, let switcherVM = assistantSwitcherViewModel {
            // Force a re-read of the lockfile before rebuilding so items
            // reflect any changes the active assistant may have missed
            // (e.g. just after a create).
            switcherVM.refresh()
            menu.addItem(NSMenuItem.separator())
            for item in AssistantSwitcherMenu.buildItems(
                viewModel: switcherVM,
                target: self,
                selectAction: #selector(assistantSwitcherDidSelect(_:)),
                createAction: #selector(assistantSwitcherDidRequestCreate(_:)),
                retireAction: #selector(assistantSwitcherDidRequestRetire(_:))
            ) {
                menu.addItem(item)
            }
        }

        menu.addItem(NSMenuItem.separator())

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
            message: "Marked \(count) conversation\(count == 1 ? "" : "s") as read",
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
        guard onboardingWindow == nil else { return nil }

        let menu = NSMenu()

        let newChatItem = NSMenuItem(title: "New Conversation", action: #selector(openNewChat), keyEquivalent: "")
        newChatItem.target = self
        menu.addItem(newChatItem)

        let markAllSeenItem = NSMenuItem(
            title: "Mark All Conversations as Read",
            action: #selector(markAllConversationsSeen),
            keyEquivalent: ""
        )
        markAllSeenItem.target = self
        menu.addItem(markAllSeenItem)

        menu.addItem(NSMenuItem.separator())

        let feedbackItem = NSMenuItem(title: "Share Feedback", action: #selector(sendFeedback), keyEquivalent: "")
        feedbackItem.target = self
        menu.addItem(feedbackItem)

        return menu
    }

    @objc public func openCurrentConversation() {
        guard !isBootstrapping else { return }
        showMainWindow()
        mainWindow?.windowState.dismissOverlay()
    }

    @objc private func rePairAssistant() {
        Task { @MainActor in
            await self.connectionManager.attemptRePair()
        }
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
    }

    @objc public func markCurrentConversationUnread() {
        guard let conversationManager = mainWindow?.conversationManager,
              let activeId = conversationManager.selectionStore.activeConversationId
        else { return }
        conversationManager.markConversationUnread(conversationId: activeId)
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
        let assistants = LockfileAssistant.loadAll()
        let connectedId = LockfileAssistant.loadActiveAssistantId()
        if let id = connectedId,
           let assistant = assistants.first(where: { $0.assistantId == id }),
           assistant.isDocker || assistant.isManaged {
            showSettingsTab("General")
            // Also check for client app updates — Sparkle handles this independently
            // of the service group update shown in Settings.
            updateManager.checkForUpdates()
            return
        }
        updateManager.checkForUpdates()
    }

    @objc func toggleSoundEffectsMute() {
        var updated = SoundManager.shared.config
        updated.globalEnabled.toggle()
        SoundManager.shared.saveConfig(updated)
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
            guard let response, response.success || !response.apps.isEmpty else { return }
            // When success is false but apps is non-empty, the response is
            // a partial decode (some items dropped). Still sync to pick up
            // new/updated apps, but skip pruning to avoid removing apps
            // that merely failed to decode.
            let isPartial = !response.success
            if !isPartial {
                self.cachedApps = response.apps
            }
            let daemonItems = response.apps.map {
                AppListManager.AppItem_Daemon(
                    id: $0.id, name: $0.name, description: $0.description,
                    icon: $0.icon, appType: nil, createdAt: $0.createdAt
                )
            }
            self.mainWindow?.appListManager.syncFromDaemon(daemonItems, skipPrune: isPartial)
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
            contentRect: NSRect(x: 0, y: 0, width: 480, height: 540),
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
            let response = await SkillsClient().fetchSkillsList(includeCatalog: false)
            guard let response else { return }
            self.cachedSkills = response.skills
        }
    }

    // MARK: - Assistant Switcher (multi-platform-assistant)

    /// Build the view model used by the menu-bar switcher. Production
    /// handlers wrap the existing `performSwitchAssistant(to:)` path, the
    /// hatch path, and the existing vellum CLI retire path.
    func makeAssistantSwitcherViewModel() -> AssistantSwitcherViewModel {
        return AssistantSwitcherViewModel(
            switchHandler: { [weak self] assistantId in
                guard let self else { return }
                // Delegate to the existing full-switch path rather than
                // `ManagedAssistantConnectionCoordinator.switchToManagedAssistant`.
                // The coordinator only handles SSE teardown + reconnect; it
                // does not close/recreate the main window, reset the avatar,
                // clear the cached organization id, cancel actor-token
                // bootstrap, or re-bootstrap the managed assistant. Wiring
                // the switcher straight into `performSwitchAssistant(to:)`
                // gives us the same battle-tested code path that
                // TeleportSection and the post-retire fallback already use.
                guard let target = LockfileAssistant.loadByName(assistantId) else {
                    throw AssistantSwitcherError.assistantNotFound(assistantId)
                }
                self.performSwitchAssistant(to: target)
            },
            createHandler: { [weak self] name in
                guard let self else { return }
                try await self.hatchAndPersistManagedAssistant(name: name)
            },
            retireHandler: { [weak self] assistantId in
                guard let self else { return }
                try await self.retireManagedAssistantFromSwitcher(assistantId: assistantId)
            }
        )
    }

    /// Hatch a new managed assistant against the platform and persist it to
    /// the lockfile. The organization id is read from UserDefaults —
    /// matching the path the onboarding flow and TeleportSection use. There
    /// is no centralized constant for this key yet; see TeleportSection for
    /// the other call site that reads it directly.
    private func hatchAndPersistManagedAssistant(name: String) async throws {
        guard let organizationId = UserDefaults.standard.string(forKey: "connectedOrganizationId"),
              !organizationId.isEmpty else {
            throw AssistantSwitcherError.noOrganizationConnected
        }
        let result = try await AuthService.shared.hatchAssistant(
            organizationId: organizationId,
            name: name
        )
        let platformAssistant: PlatformAssistant
        switch result {
        case .reusedExisting(let assistant), .createdNew(let assistant):
            platformAssistant = assistant
        }
        let success = LockfileAssistant.ensureManagedEntry(
            assistantId: platformAssistant.id,
            runtimeUrl: VellumEnvironment.resolvedPlatformURL,
            hatchedAt: platformAssistant.created_at ?? Date().iso8601String
        )
        guard success else {
            throw AssistantSwitcherError.lockfilePersistenceFailed
        }

        Task {
            try? await AuthService.shared.updateAssistant(
                id: platformAssistant.id,
                organizationId: organizationId,
                name: name
            )
        }

        IdentityInfo.seedCache(name: name, forAssistantId: platformAssistant.id)
    }

    /// Retire an assistant requested from the switcher. Today the switcher
    /// only exposes a retire row for the currently active assistant (the
    /// menu builder enforces this), so we always delegate to the existing
    /// `performRetireAsync()` path which handles fallback selection and
    /// tear-down. Retiring a non-active managed assistant requires a
    /// variant that targets an arbitrary id without tearing down the
    /// current connection — tracked as a follow-up.
    private func retireManagedAssistantFromSwitcher(assistantId: String) async throws {
        let activeId = LockfileAssistant.loadActiveAssistantId()
        guard assistantId == activeId else {
            // Defensive: the menu should never surface this row, but throw
            // a typed error rather than silently no-op if it ever does.
            throw AssistantSwitcherError.retireNonActiveNotSupported
        }
        _ = await performRetireAsync()
    }

    @objc func assistantSwitcherDidSelect(_ sender: NSMenuItem) {
        guard let assistantId = sender.representedObject as? String else { return }
        guard let vm = assistantSwitcherViewModel else { return }
        Task { @MainActor in
            do {
                try await vm.select(assistantId: assistantId)
            } catch {
                log.error("Assistant switch failed: \(error.localizedDescription, privacy: .public)")
                let alert = NSAlert()
                alert.messageText = "Could not switch assistant"
                alert.informativeText = error.localizedDescription
                alert.alertStyle = .warning
                alert.runModal()
            }
        }
    }

    @objc func assistantSwitcherDidRequestCreate(_ sender: NSMenuItem) {
        guard let vm = assistantSwitcherViewModel else { return }
        guard let name = AssistantSwitcherMenu.promptForNewAssistantName() else { return }
        Task { @MainActor in
            do {
                try await vm.createNewAssistant(name: name)
            } catch {
                log.error("New managed assistant failed: \(error.localizedDescription, privacy: .public)")
                let alert = NSAlert()
                alert.messageText = "Could not create assistant"
                alert.informativeText = error.localizedDescription
                alert.alertStyle = .warning
                alert.runModal()
            }
        }
    }

    @objc func assistantSwitcherDidRequestRetire(_ sender: NSMenuItem) {
        guard let assistantId = sender.representedObject as? String else { return }
        guard let vm = assistantSwitcherViewModel else { return }

        let assistantName = IdentityInfo.cached(for: assistantId)?.name
        let displayName = AssistantDisplayName.resolve(assistantName, assistantId)

        let confirmAlert = NSAlert()
        confirmAlert.messageText = "Retire \(displayName)?"
        confirmAlert.alertStyle = .warning
        if vm.assistants.count > 1 {
            confirmAlert.informativeText = "This will stop the current assistant and switch to another. The retired assistant's lockfile entry will be removed."
        } else {
            confirmAlert.informativeText = "This will stop the assistant, remove local data, and return to initial setup. This action cannot be undone."
        }
        confirmAlert.addButton(withTitle: "Retire")
        confirmAlert.addButton(withTitle: "Cancel")

        // Style the primary button as destructive via key equivalent
        // so Enter triggers "Retire" and Escape triggers "Cancel".
        confirmAlert.buttons[0].hasDestructiveAction = true

        let response = confirmAlert.runModal()
        guard response == .alertFirstButtonReturn else { return }

        Task { @MainActor in
            do {
                try await vm.retire(assistantId: assistantId)
            } catch {
                log.error("Retire from switcher failed: \(error.localizedDescription, privacy: .public)")
                let alert = NSAlert()
                alert.messageText = "Could not retire assistant"
                alert.informativeText = error.localizedDescription
                alert.alertStyle = .warning
                alert.runModal()
            }
        }
    }

    @objc func showPreChatPreview() {
        if let existing = preChatPreviewWindow, existing.isVisible {
            existing.makeKeyAndOrderFront(nil)
            NSApp.activate(ignoringOtherApps: true)
            return
        }

        PreChatOnboardingState.clearPersistedState()
        let flowView = PreChatOnboardingFlow { [weak self] _ in
            self?.preChatPreviewWindow?.close()
            self?.preChatPreviewWindow = nil
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(
            RadialGradient(
                colors: [VColor.surfaceBase, VColor.surfaceOverlay],
                center: .center,
                startRadius: 0,
                endRadius: 500
            )
            .ignoresSafeArea()
        )

        let hostingController = NSHostingController(rootView: flowView)
        let window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 440, height: 630),
            styleMask: [.titled, .closable, .miniaturizable, .fullSizeContentView],
            backing: .buffered,
            defer: false
        )
        window.contentViewController = hostingController
        window.contentMinSize = NSSize(width: 440, height: 630)
        window.titleVisibility = .hidden
        window.titlebarAppearsTransparent = true
        window.isMovableByWindowBackground = true
        window.backgroundColor = NSColor(VColor.surfaceOverlay)
        window.title = "PreChat Preview"
        window.setContentSize(NSSize(width: 440, height: 630))
        window.center()
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)

        preChatPreviewWindow = window
    }

    #if DEBUG
    @objc func showComponentGallery() {
        AvatarGallerySection.registerInGallery()
        HomeGallerySection.registerInGallery()
        if galleryWindow == nil { galleryWindow = ComponentGalleryWindow() }
        galleryWindow?.show()
    }

    #endif
}

/// Typed errors surfaced from the menu-bar assistant switcher. Defined here
/// (rather than alongside `ManagedAssistantConnectionCoordinatorError`)
/// because these are UI-layer failures — no organization connected, the
/// lockfile write failed, etc. — that never originate from the coordinator.
enum AssistantSwitcherError: LocalizedError {
    case noOrganizationConnected
    case lockfilePersistenceFailed
    case retireNonActiveNotSupported
    case assistantNotFound(String)

    var errorDescription: String? {
        switch self {
        case .noOrganizationConnected:
            return "No organization connected. Sign in first, then try again."
        case .lockfilePersistenceFailed:
            return "Failed to save the new assistant to your lockfile."
        case .retireNonActiveNotSupported:
            return "Retiring a non-active assistant from the switcher isn't supported yet. Switch to the assistant first, then retire it."
        case .assistantNotFound(let id):
            return "Could not find assistant \(id) in the lockfile."
        }
    }
}
