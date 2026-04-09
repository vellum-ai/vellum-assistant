import AppKit
import os

private let log = Logger(subsystem: Bundle.appBundleIdentifier, category: "SleepWake")

// MARK: - Sleep/Wake Lifecycle

extension AppDelegate {

    /// Installs observers for system sleep/wake transitions to prevent
    /// main-thread hangs caused by stale NSTextView mouse tracking loops.
    ///
    /// When the Mac sleeps while a TextField has an active mouse tracking
    /// loop (`_bellerophonTrackMouseWithMouseDownEvent`), the loop can get
    /// stuck on wake because mouse button state is stale — the button was
    /// released during sleep but the tracking loop never received the
    /// mouse-up event. This causes an indefinite main-thread hang.
    ///
    /// The fix is two-layered:
    /// 1. **Preventive** (`willSleepNotification`): End text editing before
    ///    sleep so any active mouse tracking loop terminates cleanly.
    /// 2. **Recovery** (`didWakeNotification`): Repeat the cleanup as a
    ///    safety net in case the pre-sleep handler didn't fire in time
    ///    (e.g. lid closed mid-click).
    ///
    /// References:
    /// - [willSleepNotification](https://developer.apple.com/documentation/appkit/nsworkspace/1535049-willsleepnotification)
    /// - [didWakeNotification](https://developer.apple.com/documentation/appkit/nsworkspace/1524362-didwakenotification)
    /// - [makeFirstResponder(_:)](https://developer.apple.com/documentation/appkit/nswindow/1419366-makefirstresponder)
    func setupSleepWakeHandlers() {
        let center = NSWorkspace.shared.notificationCenter

        sleepObserver = center.addObserver(
            forName: NSWorkspace.willSleepNotification,
            object: nil,
            queue: .main
        ) { [weak self] _ in
            MainActor.assumeIsolated {
                self?.handleSystemWillSleep()
            }
        }

        wakeObserver = center.addObserver(
            forName: NSWorkspace.didWakeNotification,
            object: nil,
            queue: .main
        ) { [weak self] _ in
            MainActor.assumeIsolated {
                self?.handleSystemDidWake()
            }
        }
    }

    /// Removes sleep/wake observers. Called from `applicationWillTerminate`.
    func tearDownSleepWakeHandlers() {
        let center = NSWorkspace.shared.notificationCenter
        if let observer = sleepObserver {
            center.removeObserver(observer)
            sleepObserver = nil
        }
        if let observer = wakeObserver {
            center.removeObserver(observer)
            wakeObserver = nil
        }
    }

    // MARK: - Private

    private func handleSystemWillSleep() {
        log.info("[sleepWake] System will sleep — ending text editing on all windows")
        endTextEditingOnAllWindows()
    }

    private func handleSystemDidWake() {
        log.info("[sleepWake] System did wake — clearing stale first responder state")
        endTextEditingOnAllWindows()
    }

    /// Resign the first responder on any visible window whose first
    /// responder is an NSTextView. `makeFirstResponder(nil)` tells AppKit
    /// to end the current editing session, which causes the text view's
    /// mouse tracking loop to exit its `nextEvent(matching:)` call cleanly.
    private func endTextEditingOnAllWindows() {
        for window in NSApp.windows where window.isVisible {
            if window.firstResponder is NSTextView {
                log.debug("[sleepWake] Resigning first responder on window: \(window.title, privacy: .public)")
                window.makeFirstResponder(nil)
            }
        }
    }
}
