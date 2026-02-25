import ScreenCaptureKit
import VellumAssistantShared
import os

private let log = Logger(subsystem: Bundle.main.bundleIdentifier ?? "com.vellum.vellum-assistant", category: "RecordingSourcePicker")

/// Represents an available display for recording.
struct DisplaySource: Identifiable, Hashable {
    let id: UInt32       // CGDirectDisplayID
    let name: String
    let width: Int
    let height: Int
}

/// Represents an available window for recording.
struct WindowSource: Identifiable, Hashable {
    let id: Int          // CGWindowID
    let title: String
    let appName: String
    let bundleIdentifier: String?
}

/// Whether to capture a full display or a single window.
enum CaptureScope: String, CaseIterable, Sendable {
    case display = "Display"
    case window = "Window"
}

/// View model for the recording source picker UI.
///
/// Enumerates available displays and windows via SCShareableContent
/// and lets the user choose what to record.
@MainActor
final class RecordingSourcePickerViewModel: ObservableObject {

    @Published var captureScope: CaptureScope = .display
    @Published var selectedDisplayId: UInt32?
    @Published var selectedWindowId: Int?
    @Published var includeAudio: Bool = false
    @Published var includeMicrophone: Bool = false

    @Published private(set) var displays: [DisplaySource] = []
    @Published private(set) var windows: [WindowSource] = []
    @Published private(set) var isLoading = true
    /// Brief notice shown when the selected source is no longer available
    /// after a refresh. Cleared automatically after a short delay.
    @Published var sourceUnavailableNotice: String?

    /// Computed recording options for the current selection.
    var selectedRecordingOptions: IPCRecordingOptions {
        IPCRecordingOptions(
            captureScope: captureScope.rawValue.lowercased(),
            displayId: captureScope == .display ? selectedDisplayId.map { String($0) } : nil,
            windowId: captureScope == .window ? selectedWindowId.map { Double($0) } : nil,
            includeAudio: includeAudio,
            includeMicrophone: includeMicrophone,
            promptForSource: false
        )
    }

    /// Whether the current selection is valid and recording can begin.
    var canStart: Bool {
        switch captureScope {
        case .display: return selectedDisplayId != nil
        case .window: return selectedWindowId != nil
        }
    }

    // MARK: - Load Sources

    /// Enumerate available displays and windows.
    func loadSources() async {
        isLoading = true
        defer { isLoading = false }

        do {
            let shareable = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: true)
            let selfBundleId = Bundle.main.bundleIdentifier ?? "com.vellum.vellum-assistant"

            displays = shareable.displays.map { display in
                DisplaySource(
                    id: display.displayID,
                    name: "Display \(display.displayID)",
                    width: display.width,
                    height: display.height
                )
            }

            windows = shareable.windows
                .filter { window in
                    // Exclude our own windows and windows without titles
                    guard let app = shareable.applications.first(where: { $0.processID == window.owningApplication?.processID }) else {
                        return false
                    }
                    guard app.bundleIdentifier != selfBundleId else { return false }
                    guard let title = window.title, !title.isEmpty else { return false }
                    return true
                }
                .map { window in
                    WindowSource(
                        id: Int(window.windowID),
                        title: window.title ?? "Untitled",
                        appName: window.owningApplication?.applicationName ?? "Unknown",
                        bundleIdentifier: window.owningApplication?.bundleIdentifier
                    )
                }

            // Auto-select first display if none selected
            if selectedDisplayId == nil {
                selectedDisplayId = displays.first?.id
            }

            log.info("Found \(self.displays.count) displays, \(self.windows.count) windows")
        } catch {
            log.error("Failed to enumerate shareable content: \(error.localizedDescription)")
        }
    }

    // MARK: - Refresh Sources

    /// Re-enumerate available sources while preserving the current selection.
    ///
    /// If the previously selected display or window still exists, it remains
    /// selected. If not, the selection is cleared and a brief notice is shown
    /// to inform the user.
    func refreshSources() async {
        let previousDisplayId = selectedDisplayId
        let previousWindowId = selectedWindowId
        let previousScope = captureScope

        await loadSources()

        // Check whether the previous selection still exists
        switch previousScope {
        case .display:
            if let prevId = previousDisplayId {
                if displays.contains(where: { $0.id == prevId }) {
                    // Previous display still available — keep selection
                    selectedDisplayId = prevId
                } else {
                    // Previous display is gone — clear and notify
                    selectedDisplayId = displays.first?.id
                    showSourceUnavailableNotice("The previously selected display is no longer available.")
                    log.info("Refresh: display \(prevId) no longer available — cleared selection")
                }
            }
        case .window:
            if let prevId = previousWindowId {
                if windows.contains(where: { $0.id == prevId }) {
                    // Previous window still available — keep selection
                    selectedWindowId = prevId
                } else {
                    // Previous window is gone — clear and notify
                    selectedWindowId = nil
                    showSourceUnavailableNotice("The previously selected window is no longer available.")
                    log.info("Refresh: window \(prevId) no longer available — cleared selection")
                }
            }
        }
    }

    /// Show a brief unavailability notice, auto-clearing after 4 seconds.
    private func showSourceUnavailableNotice(_ message: String) {
        sourceUnavailableNotice = message
        Task {
            try? await Task.sleep(nanoseconds: 4_000_000_000)
            // Only clear if the message hasn't been replaced by a newer one
            if sourceUnavailableNotice == message {
                sourceUnavailableNotice = nil
            }
        }
    }
}
