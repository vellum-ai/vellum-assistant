import Foundation
import CoreGraphics
import AppKit
import VellumAssistantShared
import os

private let log = Logger(subsystem: Bundle.main.bundleIdentifier ?? "com.vellum.vellum-assistant", category: "RecordingSourcePicker")

// MARK: - Display Source

/// Represents a physical display available for recording.
struct DisplaySource: Identifiable, Equatable {
    let id: CGDirectDisplayID
    let name: String
    let width: Int
    let height: Int
    let isMain: Bool

    var resolution: String { "\(width) x \(height)" }
}

// MARK: - Window Source

/// Represents an on-screen window available for recording.
struct WindowSource: Identifiable, Equatable {
    let id: CGWindowID
    let name: String
    let ownerName: String
    let ownerPID: pid_t
}

// MARK: - Capture Scope

enum CaptureScope: String, CaseIterable {
    case display
    case window
}

// MARK: - Saved Preference

/// Persisted recording source preference for auto-apply on subsequent sessions.
struct RecordingSourcePreference: Codable, Equatable {
    let scope: String
    let displayId: CGDirectDisplayID?
    let windowOwnerName: String?
    let includeAudio: Bool
}

// MARK: - ViewModel

@MainActor
final class RecordingSourcePickerViewModel: ObservableObject {
    @Published var captureScope: CaptureScope = .display
    @Published var selectedDisplayId: CGDirectDisplayID?
    @Published var selectedWindowId: CGWindowID?
    @Published var includeAudio: Bool = false
    @Published var rememberChoice: Bool = false

    @Published private(set) var displays: [DisplaySource] = []
    @Published private(set) var windows: [WindowSource] = []

    private let userDefaultsKey = "recordingSourcePreference"
    private let defaults: UserDefaults

    init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
        enumerateDisplays()
    }

    // MARK: - Computed Properties

    var hasMultipleDisplays: Bool {
        displays.count > 1
    }

    var selectedRecordingOptions: IPCRecordingOptions {
        switch captureScope {
        case .display:
            return IPCRecordingOptions(
                captureScope: "display",
                displayId: selectedDisplayId.map { String($0) },
                windowId: nil,
                includeAudio: includeAudio,
                promptForSource: nil
            )
        case .window:
            return IPCRecordingOptions(
                captureScope: "window",
                displayId: nil,
                windowId: selectedWindowId.map { Double($0) },
                includeAudio: includeAudio,
                promptForSource: nil
            )
        }
    }

    // MARK: - Source Enumeration

    func enumerateDisplays() {
        var displayCount: UInt32 = 0
        CGGetActiveDisplayList(0, nil, &displayCount)

        guard displayCount > 0 else {
            displays = []
            return
        }

        var displayIDs = [CGDirectDisplayID](repeating: 0, count: Int(displayCount))
        CGGetActiveDisplayList(displayCount, &displayIDs, &displayCount)

        let mainDisplayID = CGMainDisplayID()

        displays = displayIDs.enumerated().map { index, displayID in
            let width = CGDisplayPixelsWide(displayID)
            let height = CGDisplayPixelsHigh(displayID)
            let isMain = displayID == mainDisplayID

            // Try to get a friendly name from NSScreen
            let name = Self.screenName(for: displayID, index: index, isMain: isMain)

            return DisplaySource(
                id: displayID,
                name: name,
                width: width,
                height: height,
                isMain: isMain
            )
        }

        // Auto-select the main display if nothing is selected
        if selectedDisplayId == nil {
            selectedDisplayId = displays.first(where: { $0.isMain })?.id ?? displays.first?.id
        }

        log.info("Enumerated \(self.displays.count) display(s)")
    }

    func enumerateWindows() {
        let options: CGWindowListOption = [.optionOnScreenOnly, .excludeDesktopElements]
        guard let windowList = CGWindowListCopyWindowInfo(options, kCGNullWindowID) as? [[String: Any]] else {
            windows = []
            return
        }

        let selfPID = ProcessInfo.processInfo.processIdentifier

        windows = windowList.compactMap { info -> WindowSource? in
            guard let windowID = info[kCGWindowNumber as String] as? CGWindowID,
                  let ownerPID = info[kCGWindowOwnerPID as String] as? pid_t,
                  let ownerName = info[kCGWindowOwnerName as String] as? String,
                  let layer = info[kCGWindowLayer as String] as? Int,
                  layer == 0, // Normal windows only (not menu bar, dock, etc.)
                  ownerPID != selfPID // Exclude our own windows
            else { return nil }

            let windowName = info[kCGWindowName as String] as? String
            let displayName = windowName?.isEmpty == false ? windowName! : ownerName

            return WindowSource(
                id: windowID,
                name: displayName,
                ownerName: ownerName,
                ownerPID: ownerPID
            )
        }

        // Auto-select the first window if nothing is selected
        if selectedWindowId == nil {
            selectedWindowId = windows.first?.id
        }

        log.info("Enumerated \(self.windows.count) window(s)")
    }

    // MARK: - Preference Persistence

    func savePreference() {
        let preference = RecordingSourcePreference(
            scope: captureScope.rawValue,
            displayId: captureScope == .display ? selectedDisplayId : nil,
            windowOwnerName: captureScope == .window ? windows.first(where: { $0.id == selectedWindowId })?.ownerName : nil,
            includeAudio: includeAudio
        )

        if let data = try? JSONEncoder().encode(preference) {
            defaults.set(data, forKey: userDefaultsKey)
            log.info("Saved recording source preference")
        }
    }

    func loadPreference() -> RecordingSourcePreference? {
        guard let data = defaults.data(forKey: userDefaultsKey) else { return nil }
        return try? JSONDecoder().decode(RecordingSourcePreference.self, from: data)
    }

    func clearPreference() {
        defaults.removeObject(forKey: userDefaultsKey)
    }

    /// Attempts to apply a saved preference. Returns true if the saved source
    /// still exists and was successfully applied, false otherwise.
    func canAutoApply() -> Bool {
        guard let pref = loadPreference() else { return false }

        if pref.scope == CaptureScope.display.rawValue {
            // Saved display must still be connected
            guard let displayId = pref.displayId,
                  displays.contains(where: { $0.id == displayId }) else {
                return false
            }
            captureScope = .display
            selectedDisplayId = displayId
            includeAudio = pref.includeAudio
            return true
        } else if pref.scope == CaptureScope.window.rawValue {
            // For windows, match by owner name since window IDs are ephemeral
            enumerateWindows()
            guard let ownerName = pref.windowOwnerName,
                  let matchingWindow = windows.first(where: { $0.ownerName == ownerName }) else {
                return false
            }
            captureScope = .window
            selectedWindowId = matchingWindow.id
            includeAudio = pref.includeAudio
            return true
        }

        return false
    }

    // MARK: - Private Helpers

    private static func screenName(for displayID: CGDirectDisplayID, index: Int, isMain: Bool) -> String {
        // Try to match NSScreen to get the localized name
        if let screen = NSScreen.screens.first(where: { screen in
            guard let screenNumber = screen.deviceDescription[NSDeviceDescriptionKey("NSScreenNumber")] as? CGDirectDisplayID else {
                return false
            }
            return screenNumber == displayID
        }) {
            return screen.localizedName
        }

        // Fallback name
        return isMain ? "Main Display" : "Display \(index + 1)"
    }
}
