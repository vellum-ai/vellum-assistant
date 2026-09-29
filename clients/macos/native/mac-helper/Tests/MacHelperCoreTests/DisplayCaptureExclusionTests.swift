import Foundation
import Testing

@testable import MacHelperCore

@Suite("DisplayCaptureExclusion")
struct DisplayCaptureExclusionTests {
    private let helperPID: pid_t = 200
    private let hostPID: pid_t = 100
    private let floatingLayer = 3

    @Test("the app's ordinary windows are kept")
    func hostNormalWindowKept() {
        #expect(!DisplayCaptureExclusion.excludes(ownerPID: hostPID, layer: 0, helperPID: helperPID, hostPID: hostPID))
    }

    @Test("the app's floating windows are left out")
    func hostFloatingWindowExcluded() {
        #expect(DisplayCaptureExclusion.excludes(ownerPID: hostPID, layer: floatingLayer, helperPID: helperPID, hostPID: hostPID))
    }

    @Test("the helper's windows are left out at any layer")
    func helperWindowsExcluded() {
        #expect(DisplayCaptureExclusion.excludes(ownerPID: helperPID, layer: 0, helperPID: helperPID, hostPID: hostPID))
        #expect(DisplayCaptureExclusion.excludes(ownerPID: helperPID, layer: floatingLayer, helperPID: helperPID, hostPID: hostPID))
    }

    @Test("other apps' windows are kept at any layer")
    func otherAppsKept() {
        #expect(!DisplayCaptureExclusion.excludes(ownerPID: 300, layer: 0, helperPID: helperPID, hostPID: hostPID))
        #expect(!DisplayCaptureExclusion.excludes(ownerPID: 300, layer: floatingLayer, helperPID: helperPID, hostPID: hostPID))
    }
}
