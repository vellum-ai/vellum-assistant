import AppKit
import ScreenCaptureKit
import VellumAssistantShared
import os

private let log = Logger(subsystem: Bundle.main.bundleIdentifier ?? "com.vellum.vellum-assistant", category: "RecordingSourcePicker")

// MARK: - Preview Types

/// Reason a source preview capture failed.
enum PreviewFailureReason: String, Equatable, Hashable, Sendable {
    case captureFailed = "capture_failed"
    case blankFrame = "blank_frame"
    case sourceGone = "source_gone"
    case cancelled = "cancelled"
}

/// Status of thumbnail preview capture for a source.
enum PreviewStatus: Equatable, Hashable, Sendable {
    case idle
    case loading
    case loaded
    case failed(PreviewFailureReason)
}

// MARK: - Source Types

/// Represents an available display for recording.
struct DisplaySource: Identifiable, Hashable {
    let id: UInt32       // CGDirectDisplayID
    let name: String
    let width: Int
    let height: Int
    let scaleFactor: CGFloat
    /// Whether the picker window is currently on this display.
    var isCurrentDisplay: Bool
    /// Preview thumbnail image (not included in hash/equality).
    var thumbnail: NSImage?
    /// Current preview capture status.
    var previewStatus: PreviewStatus = .idle
    /// Reference to SCDisplay for content filter creation (not included in hash/equality).
    var scDisplay: SCDisplay?

    /// Human-readable resolution and scale, e.g. "2560 × 1440 @ 2x".
    var subtitle: String {
        let scaleLabel = scaleFactor >= 2 ? "@ \(Int(scaleFactor))x" : "@ 1x"
        return "\(width) × \(height) \(scaleLabel)"
    }

    // Identity is based solely on the display ID so SwiftUI diffing
    // doesn't trigger spurious rebuilds when thumbnails arrive.
    static func == (lhs: DisplaySource, rhs: DisplaySource) -> Bool {
        lhs.id == rhs.id
    }

    func hash(into hasher: inout Hasher) {
        hasher.combine(id)
    }
}

/// Represents an available window for recording.
struct WindowSource: Identifiable, Hashable {
    let id: Int          // CGWindowID
    let title: String
    let appName: String
    let bundleIdentifier: String?
    /// Preview thumbnail image (not included in hash/equality).
    var thumbnail: NSImage?
    /// Current preview capture status.
    var previewStatus: PreviewStatus = .idle
    /// Reference to SCWindow for content filter creation (not included in hash/equality).
    var scWindow: SCWindow?

    // Identity is based solely on the window ID.
    static func == (lhs: WindowSource, rhs: WindowSource) -> Bool {
        lhs.id == rhs.id
    }

    func hash(into hasher: inout Hasher) {
        hasher.combine(id)
    }
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

    /// The picker window, used to determine which display it's on.
    weak var pickerWindow: NSWindow?

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

            // Build a lookup from CGDirectDisplayID -> NSScreen for metadata
            let screens = NSScreen.screens
            let screensByDisplayId: [UInt32: NSScreen] = {
                var map: [UInt32: NSScreen] = [:]
                for screen in screens {
                    if let screenNumber = screen.deviceDescription[NSDeviceDescriptionKey("NSScreenNumber")] as? UInt32 {
                        map[screenNumber] = screen
                    }
                }
                return map
            }()

            // Determine which display the picker window is on
            let pickerDisplayId: UInt32? = {
                guard let pickerScreen = pickerWindow?.screen ?? NSScreen.main else { return nil }
                return pickerScreen.deviceDescription[NSDeviceDescriptionKey("NSScreenNumber")] as? UInt32
            }()

            var displaySources = shareable.displays.enumerated().map { (index, display) -> DisplaySource in
                let screen = screensByDisplayId[display.displayID]
                let scale = screen?.backingScaleFactor ?? 1.0
                let name: String = {
                    if let screen = screen {
                        return screen.localizedName
                    }
                    // Fall back to 1-based index if NSScreen lookup fails
                    return "Display \(index + 1)"
                }()

                return DisplaySource(
                    id: display.displayID,
                    name: name,
                    width: display.width,
                    height: display.height,
                    scaleFactor: scale,
                    isCurrentDisplay: display.displayID == pickerDisplayId,
                    scDisplay: display
                )
            }

            // Sort: built-in display first, then by horizontal position (leftmost first)
            displaySources.sort { a, b in
                let screenA = screensByDisplayId[a.id]
                let screenB = screensByDisplayId[b.id]
                let isBuiltInA = CGDisplayIsBuiltin(a.id) != 0
                let isBuiltInB = CGDisplayIsBuiltin(b.id) != 0
                if isBuiltInA != isBuiltInB { return isBuiltInA }
                let xA = screenA?.frame.origin.x ?? CGFloat.greatestFiniteMagnitude
                let xB = screenB?.frame.origin.x ?? CGFloat.greatestFiniteMagnitude
                return xA < xB
            }

            displays = displaySources

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
                        bundleIdentifier: window.owningApplication?.bundleIdentifier,
                        scWindow: window
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

    // MARK: - Update Current Display

    /// Recalculates `isCurrentDisplay` for every display source based on
    /// the screen the picker window currently occupies.  Because `displays`
    /// is `@Published`, the UI updates reactively.
    func updateCurrentDisplay() {
        guard let pickerScreen = pickerWindow?.screen else { return }
        let pickerDisplayId = pickerScreen.deviceDescription[
            NSDeviceDescriptionKey("NSScreenNumber")
        ] as? UInt32

        displays = displays.map { source in
            var updated = source
            updated.isCurrentDisplay = (source.id == pickerDisplayId)
            return updated
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

    // MARK: - Preview Loading

    private let thumbnailProvider = ThumbnailProvider()

    /// Load preview thumbnails for all currently visible sources.
    /// Must be called after `loadSources()` completes. Does not block
    /// source loading — previews arrive asynchronously and update the UI.
    func loadPreviews() async {
        guard FeatureFlagManager.shared.isEnabled(.sourcePreviewEnabled) else { return }

        switch captureScope {
        case .display:
            for i in displays.indices {
                displays[i].previewStatus = .loading
            }
            // Capture in parallel with concurrency limited by the provider
            await withTaskGroup(of: (UInt32, NSImage?, PreviewStatus).self) { group in
                for display in displays {
                    group.addTask { [thumbnailProvider] in
                        let result = await thumbnailProvider.captureThumbnail(for: display)
                        return (display.id, result.image, result.status)
                    }
                }
                for await (displayId, image, status) in group {
                    if let idx = displays.firstIndex(where: { $0.id == displayId }) {
                        displays[idx].thumbnail = image
                        displays[idx].previewStatus = status
                    }
                }
            }

        case .window:
            for i in windows.indices {
                windows[i].previewStatus = .loading
            }
            await withTaskGroup(of: (Int, NSImage?, PreviewStatus).self) { group in
                for window in windows {
                    group.addTask { [thumbnailProvider] in
                        let result = await thumbnailProvider.captureThumbnail(for: window)
                        return (window.id, result.image, result.status)
                    }
                }
                for await (windowId, image, status) in group {
                    if let idx = windows.firstIndex(where: { $0.id == windowId }) {
                        windows[idx].thumbnail = image
                        windows[idx].previewStatus = status
                    }
                }
            }
        }
    }

    /// Clear thumbnail caches when the picker is dismissed.
    func clearPreviews() {
        Task {
            await thumbnailProvider.clearCache()
        }
    }
}
