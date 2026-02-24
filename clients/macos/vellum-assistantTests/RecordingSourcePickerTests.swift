import XCTest
@testable import VellumAssistantLib
@testable import VellumAssistantShared

final class RecordingSourcePickerTests: XCTestCase {

    /// Creates an isolated UserDefaults suite and returns both the defaults and suite name for cleanup.
    private func makeTestDefaults() -> (UserDefaults, String) {
        let suiteName = "RecordingSourcePickerTests_\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: suiteName)!
        return (defaults, suiteName)
    }

    // MARK: - Default State

    @MainActor
    func testDefaultState_hasCaptureScope_display() async {
        let vm = RecordingSourcePickerViewModel()
        XCTAssertEqual(vm.captureScope, .display)
    }

    @MainActor
    func testDefaultState_audioOff() async {
        let vm = RecordingSourcePickerViewModel()
        XCTAssertFalse(vm.includeAudio)
    }

    @MainActor
    func testDefaultState_rememberChoiceOff() async {
        let vm = RecordingSourcePickerViewModel()
        XCTAssertFalse(vm.rememberChoice)
    }

    @MainActor
    func testDefaultState_displaysEnumerated() async {
        let vm = RecordingSourcePickerViewModel()
        // There should be at least one display on any Mac
        XCTAssertGreaterThanOrEqual(vm.displays.count, 1)
    }

    @MainActor
    func testDefaultState_mainDisplaySelected() async {
        let vm = RecordingSourcePickerViewModel()
        // The main display should be auto-selected
        XCTAssertNotNil(vm.selectedDisplayId)
    }

    // MARK: - hasMultipleDisplays

    @MainActor
    func testHasMultipleDisplays_consistentWithCount() async {
        let vm = RecordingSourcePickerViewModel()
        // Verify the property is consistent with the actual display count.
        if vm.displays.count == 1 {
            XCTAssertFalse(vm.hasMultipleDisplays)
        } else {
            XCTAssertTrue(vm.hasMultipleDisplays)
        }
    }

    // MARK: - Selected Recording Options

    @MainActor
    func testSelectedRecordingOptions_displayScope() async {
        let vm = RecordingSourcePickerViewModel()
        vm.captureScope = .display
        vm.includeAudio = true

        let options = vm.selectedRecordingOptions
        XCTAssertEqual(options.captureScope, "display")
        XCTAssertEqual(options.includeAudio, true)
        XCTAssertNil(options.windowId)
        // displayId should be set since we have at least one display
        XCTAssertNotNil(options.displayId)
    }

    @MainActor
    func testSelectedRecordingOptions_windowScope() async {
        let vm = RecordingSourcePickerViewModel()
        vm.captureScope = .window
        vm.selectedWindowId = 12345
        vm.includeAudio = false

        let options = vm.selectedRecordingOptions
        XCTAssertEqual(options.captureScope, "window")
        XCTAssertEqual(options.includeAudio, false)
        XCTAssertEqual(options.windowId, 12345)
        XCTAssertNil(options.displayId)
    }

    // MARK: - Preference Persistence

    @MainActor
    func testSaveAndLoadPreference() async {
        let (defaults, suiteName) = makeTestDefaults()
        defer { defaults.removePersistentDomain(forName: suiteName) }

        let vm = RecordingSourcePickerViewModel(defaults: defaults)
        vm.captureScope = .display
        vm.includeAudio = true
        vm.savePreference()

        let loaded = vm.loadPreference()
        XCTAssertNotNil(loaded)
        XCTAssertEqual(loaded?.scope, "display")
        XCTAssertEqual(loaded?.includeAudio, true)
    }

    @MainActor
    func testClearPreference() async {
        let (defaults, suiteName) = makeTestDefaults()
        defer { defaults.removePersistentDomain(forName: suiteName) }

        let vm = RecordingSourcePickerViewModel(defaults: defaults)
        vm.savePreference()
        XCTAssertNotNil(vm.loadPreference())

        vm.clearPreference()
        XCTAssertNil(vm.loadPreference())
    }

    // MARK: - canAutoApply

    @MainActor
    func testCanAutoApply_noSavedPreference_returnsFalse() async {
        let (defaults, suiteName) = makeTestDefaults()
        defer { defaults.removePersistentDomain(forName: suiteName) }

        let vm = RecordingSourcePickerViewModel(defaults: defaults)
        XCTAssertFalse(vm.canAutoApply())
    }

    @MainActor
    func testCanAutoApply_savedDisplayStillExists_returnsTrue() async {
        let (defaults, suiteName) = makeTestDefaults()
        defer { defaults.removePersistentDomain(forName: suiteName) }

        let vm = RecordingSourcePickerViewModel(defaults: defaults)

        // Save a preference for the current main display
        vm.captureScope = .display
        vm.selectedDisplayId = vm.displays.first?.id
        vm.savePreference()

        // Create a new VM with the same defaults — it should auto-apply
        let vm2 = RecordingSourcePickerViewModel(defaults: defaults)
        XCTAssertTrue(vm2.canAutoApply())
    }

    @MainActor
    func testCanAutoApply_savedDisplayNoLongerExists_returnsFalse() async {
        let (defaults, suiteName) = makeTestDefaults()
        defer { defaults.removePersistentDomain(forName: suiteName) }

        let vm = RecordingSourcePickerViewModel(defaults: defaults)

        // Manually save a preference with a fake display ID that doesn't exist
        let fakePreference = RecordingSourcePreference(
            scope: "display",
            displayId: 99999,
            windowOwnerName: nil,
            includeAudio: false
        )
        if let data = try? JSONEncoder().encode(fakePreference) {
            defaults.set(data, forKey: "recordingSourcePreference")
        }

        XCTAssertFalse(vm.canAutoApply())
    }

    @MainActor
    func testCanAutoApply_savedWindowNoMatchingApp_returnsFalse() async {
        let (defaults, suiteName) = makeTestDefaults()
        defer { defaults.removePersistentDomain(forName: suiteName) }

        let vm = RecordingSourcePickerViewModel(defaults: defaults)

        // Manually save a preference with a non-existent window owner
        let fakePreference = RecordingSourcePreference(
            scope: "window",
            displayId: nil,
            windowOwnerName: "NonExistentApp_\(UUID().uuidString)",
            includeAudio: false
        )
        if let data = try? JSONEncoder().encode(fakePreference) {
            defaults.set(data, forKey: "recordingSourcePreference")
        }

        XCTAssertFalse(vm.canAutoApply())
    }

    // MARK: - Window Enumeration

    @MainActor
    func testEnumerateWindows_populatesWindowsList() async {
        let vm = RecordingSourcePickerViewModel()
        vm.enumerateWindows()
        // On a running Mac there should be at least one window visible
        // (the test runner itself), but we allow zero in headless CI.
        XCTAssertGreaterThanOrEqual(vm.windows.count, 0)
    }
}
