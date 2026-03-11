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

    // MARK: - Window Sizing

    /// Maximum number of source rows visible without scrolling.
    static let maxVisibleSourceRows = 3

    /// Calculate the ideal window height for the given number of source items.
    ///
    /// Sizes the window to fit up to 3 source rows without scrolling.
    /// Beyond 3, the source list scrolls at the capped height.
    static func idealWindowHeight(sourceCount: Int) -> CGFloat {
        let fixedHeight: CGFloat = 444
        let rowAllocation: CGFloat = 78
        let listPadding: CGFloat = 12
        let visibleRows = min(max(sourceCount, 1), maxVisibleSourceRows)
        return fixedHeight + rowAllocation * CGFloat(visibleRows) + listPadding
    }

    /// Resize the picker window to fit the current number of source items.
    ///
    /// Keeps the window's top edge fixed while adjusting the height.
    /// Converts the desired content height to frame height so the calculation
    /// is correct regardless of title-bar style.
    func updateWindowSize() {
        guard let window = pickerWindow else { return }
        let sourceCount = captureScope == .display ? displays.count : windows.count
        let idealContentHeight = Self.idealWindowHeight(sourceCount: sourceCount)

        let contentRect = NSRect(x: 0, y: 0, width: window.frame.width, height: idealContentHeight)
        let targetFrameHeight = window.frameRect(forContentRect: contentRect).height

        var frame = window.frame
        frame.origin.y += frame.size.height - targetFrameHeight
        frame.size.height = targetFrameHeight
        window.setFrame(frame, display: true, animate: true)
    }

    /// Computed recording options for the current selection.
    var selectedRecordingOptions: RecordingOptions {
        RecordingOptions(
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

    /// The currently selected source's thumbnail, if any.
    var selectedThumbnail: NSImage? {
        switch captureScope {
        case .display:
            guard let id = selectedDisplayId else { return nil }
            return displays.first(where: { $0.id == id })?.thumbnail
        case .window:
            guard let id = selectedWindowId else { return nil }
            return windows.first(where: { $0.id == id })?.thumbnail
        }
    }

    /// The preview status of the currently selected source.
    var selectedPreviewStatus: PreviewStatus {
        switch captureScope {
        case .display:
            guard let id = selectedDisplayId else { return .idle }
            return displays.first(where: { $0.id == id })?.previewStatus ?? .idle
        case .window:
            guard let id = selectedWindowId else { return .idle }
            return windows.first(where: { $0.id == id })?.previewStatus ?? .idle
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
        // Cancel in-flight preview tasks before refreshing the source list
        previewTask?.cancel()
        previewGeneration += 1

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

        // Reload previews for the refreshed source list
        await loadPreviews()
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
    /// In-flight preview loading task — cancelled on scope switch, refresh, or dismiss.
    private var previewTask: Task<Void, Never>?
    /// Monotonic counter incremented each time previews are loaded or sources are refreshed.
    /// Used to discard stale capture results from a previous scope/refresh cycle.
    private var previewGeneration: Int = 0

    // MARK: - Preview Telemetry Counters

    private var previewAttemptCount = 0
    private var previewSuccessCount = 0
    private var previewFailureCount = 0
    private var previewCancelCount = 0
    private var previewTotalLatencyMs = 0
    private var previewCacheHitCount = 0

    /// Map a `PreviewFailureReason` to the telemetry `PreviewErrorCategory`.
    private static func errorCategory(from reason: PreviewFailureReason) -> RecordingTelemetry.PreviewErrorCategory {
        switch reason {
        case .captureFailed: return .captureFailed
        case .blankFrame: return .blankFrame
        case .sourceGone: return .sourceGone
        case .cancelled: return .cancelled
        }
    }

    /// Record telemetry for a single preview result.
    /// Only adds latency for non-cancelled results so the session average
    /// (which divides by success + failure count) isn't inflated.
    private func recordResultTelemetry(sourceType: String, sourceId: String, status: PreviewStatus, latencyMs: Int, fromCache: Bool) {
        previewAttemptCount += 1
        switch status {
        case .loaded:
            previewTotalLatencyMs += latencyMs
            previewSuccessCount += 1
            if fromCache { previewCacheHitCount += 1 }
            RecordingTelemetry.logPreviewGenerated(sourceType: sourceType, sourceId: sourceId, latencyMs: latencyMs, fromCache: fromCache)
        case .failed(let reason):
            if reason == .cancelled {
                previewCancelCount += 1
                RecordingTelemetry.logPreviewCancelled(sourceType: sourceType, sourceId: sourceId, reason: "task_cancelled")
            } else {
                previewTotalLatencyMs += latencyMs
                previewFailureCount += 1
                RecordingTelemetry.logPreviewFailed(sourceType: sourceType, sourceId: sourceId, category: Self.errorCategory(from: reason), latencyMs: latencyMs)
            }
        case .idle, .loading:
            break
        }
    }

    /// Load preview thumbnails for all currently visible sources.
    /// Must be called after `loadSources()` completes. Does not block
    /// source loading — previews arrive asynchronously and update the UI.
    func loadPreviews() async {
        // Cancel any in-flight preview work from a previous scope or refresh
        previewTask?.cancel()

        previewGeneration += 1
        let generation = previewGeneration

        let task = Task { @MainActor [weak self] in
            guard let self else { return }

            switch self.captureScope {
            case .display:
                for i in self.displays.indices {
                    self.displays[i].previewStatus = .loading
                }
                let totalDisplaySources = self.displays.count
                await withTaskGroup(of: (UInt32, NSImage?, PreviewStatus, Int, Bool).self) { group in
                    for display in self.displays {
                        group.addTask { [thumbnailProvider = self.thumbnailProvider] in
                            // Check cancellation before starting each capture
                            guard !Task.isCancelled else {
                                return (display.id, nil, PreviewStatus.failed(.cancelled), 0, false)
                            }
                            let start = Date()
                            let result = await thumbnailProvider.captureThumbnail(for: display)
                            let latencyMs = Int(Date().timeIntervalSince(start) * 1000)
                            return (display.id, result.image, result.status, latencyMs, result.fromCache)
                        }
                    }
                    var processedCount = 0
                    for await (displayId, image, status, latencyMs, fromCache) in group {
                        let currentSourceId = String(displayId)

                        // Discard stale results from a previous generation;
                        // cancel remaining children so they release semaphore slots promptly.
                        // Record telemetry for the current (already-completed) result before exiting.
                        guard self.previewGeneration == generation else {
                            self.recordResultTelemetry(sourceType: "display", sourceId: currentSourceId, status: status, latencyMs: latencyMs, fromCache: fromCache)
                            let remaining = totalDisplaySources - processedCount - 1
                            if remaining > 0 {
                                self.previewAttemptCount += remaining
                                self.previewCancelCount += remaining
                                RecordingTelemetry.logPreviewCancelled(sourceType: "display", sourceId: "batch", reason: "generation_mismatch_\(remaining)_sources")
                            }
                            group.cancelAll()
                            return
                        }
                        guard !Task.isCancelled else {
                            self.recordResultTelemetry(sourceType: "display", sourceId: currentSourceId, status: status, latencyMs: latencyMs, fromCache: fromCache)
                            let remaining = totalDisplaySources - processedCount - 1
                            if remaining > 0 {
                                self.previewAttemptCount += remaining
                                self.previewCancelCount += remaining
                                RecordingTelemetry.logPreviewCancelled(sourceType: "display", sourceId: "batch", reason: "task_cancelled_\(remaining)_sources")
                            }
                            group.cancelAll()
                            return
                        }
                        processedCount += 1
                        if let idx = self.displays.firstIndex(where: { $0.id == displayId }) {
                            self.displays[idx].thumbnail = image
                            self.displays[idx].previewStatus = status
                        }

                        self.recordResultTelemetry(sourceType: "display", sourceId: currentSourceId, status: status, latencyMs: latencyMs, fromCache: fromCache)
                    }
                }

            case .window:
                for i in self.windows.indices {
                    self.windows[i].previewStatus = .loading
                }
                let totalWindowSources = self.windows.count
                await withTaskGroup(of: (Int, NSImage?, PreviewStatus, Int, Bool).self) { group in
                    for window in self.windows {
                        group.addTask { [thumbnailProvider = self.thumbnailProvider] in
                            guard !Task.isCancelled else {
                                return (window.id, nil, PreviewStatus.failed(.cancelled), 0, false)
                            }
                            let start = Date()
                            let result = await thumbnailProvider.captureThumbnail(for: window)
                            let latencyMs = Int(Date().timeIntervalSince(start) * 1000)
                            return (window.id, result.image, result.status, latencyMs, result.fromCache)
                        }
                    }
                    var processedCount = 0
                    for await (windowId, image, status, latencyMs, fromCache) in group {
                        let currentSourceId = String(windowId)

                        // Record telemetry for the current (already-completed) result before exiting.
                        guard self.previewGeneration == generation else {
                            self.recordResultTelemetry(sourceType: "window", sourceId: currentSourceId, status: status, latencyMs: latencyMs, fromCache: fromCache)
                            let remaining = totalWindowSources - processedCount - 1
                            if remaining > 0 {
                                self.previewAttemptCount += remaining
                                self.previewCancelCount += remaining
                                RecordingTelemetry.logPreviewCancelled(sourceType: "window", sourceId: "batch", reason: "generation_mismatch_\(remaining)_sources")
                            }
                            group.cancelAll()
                            return
                        }
                        guard !Task.isCancelled else {
                            self.recordResultTelemetry(sourceType: "window", sourceId: currentSourceId, status: status, latencyMs: latencyMs, fromCache: fromCache)
                            let remaining = totalWindowSources - processedCount - 1
                            if remaining > 0 {
                                self.previewAttemptCount += remaining
                                self.previewCancelCount += remaining
                                RecordingTelemetry.logPreviewCancelled(sourceType: "window", sourceId: "batch", reason: "task_cancelled_\(remaining)_sources")
                            }
                            group.cancelAll()
                            return
                        }
                        processedCount += 1
                        if let idx = self.windows.firstIndex(where: { $0.id == windowId }) {
                            self.windows[idx].thumbnail = image
                            self.windows[idx].previewStatus = status
                        }

                        self.recordResultTelemetry(sourceType: "window", sourceId: currentSourceId, status: status, latencyMs: latencyMs, fromCache: fromCache)
                    }
                }
            }
        }

        previewTask = task
        await task.value
    }

    /// Clear thumbnail caches and cancel in-flight tasks when the picker is dismissed.
    func clearPreviews() async {
        previewTask?.cancel()
        await previewTask?.value  // Wait for task to finish cleanup so cancel counts are finalized
        previewTask = nil

        // Log session summary if any previews were attempted
        if previewAttemptCount > 0 {
            let completedCount = previewSuccessCount + previewFailureCount
            let avgLatency = completedCount > 0 ? previewTotalLatencyMs / completedCount : 0
            let cacheHitRate = previewSuccessCount > 0
                ? Double(previewCacheHitCount) / Double(previewSuccessCount)
                : 0.0

            RecordingTelemetry.logPreviewSessionSummary(
                totalAttempted: previewAttemptCount,
                succeeded: previewSuccessCount,
                failed: previewFailureCount,
                cancelled: previewCancelCount,
                avgLatencyMs: avgLatency,
                cacheHitRate: cacheHitRate
            )
        }

        // Reset telemetry counters
        previewAttemptCount = 0
        previewSuccessCount = 0
        previewFailureCount = 0
        previewCancelCount = 0
        previewTotalLatencyMs = 0
        previewCacheHitCount = 0

        // Reset all sources' preview states
        for i in displays.indices {
            displays[i].previewStatus = .idle
            displays[i].thumbnail = nil
        }
        for i in windows.indices {
            windows[i].previewStatus = .idle
            windows[i].thumbnail = nil
        }

        Task {
            await thumbnailProvider.clearCache()
        }
    }
}
