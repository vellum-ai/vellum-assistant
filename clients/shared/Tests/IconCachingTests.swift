import XCTest
@testable import VellumAssistantShared

#if canImport(AppKit) && !targetEnvironment(macCatalyst)
import AppKit

final class IconCachingTests: XCTestCase {

    // MARK: - Identity stability (same icon + same size)

    /// Requesting the same icon at the same size must return the identical NSImage instance.
    func testSameIconSameSizeReturnsSameInstance() {
        let icon = VIcon.search
        let a = icon.nsImage(size: 24)
        let b = icon.nsImage(size: 24)
        XCTAssertNotNil(a)
        XCTAssertTrue(a === b, "Same icon + same size should return identical NSImage instance")
    }

    // MARK: - Size cross-contamination guard

    /// Different sizes for the same icon must produce distinct instances so one size
    /// does not overwrite another.
    func testSameIconDifferentSizeReturnsDifferentInstances() {
        let icon = VIcon.search
        let small = icon.nsImage(size: 16)
        let large = icon.nsImage(size: 32)
        XCTAssertNotNil(small)
        XCTAssertNotNil(large)
        XCTAssertFalse(small === large, "Different sizes should return different NSImage instances")
    }

    // MARK: - Unsized stability

    /// The unsized `nsImage` property must return a stable identity across repeated access.
    func testUnsizedNSImageReturnsStableIdentity() {
        let icon = VIcon.check
        let a = icon.nsImage
        let b = icon.nsImage
        XCTAssertNotNil(a)
        XCTAssertTrue(a === b, "Unsized nsImage should return identical instance across repeated access")
    }

    // MARK: - isTemplate preservation

    /// Cached images must preserve `isTemplate == true` so AppKit renders them
    /// correctly with the current accent/foreground color.
    func testCachedImagesPreserveIsTemplate() {
        let icon = VIcon.star
        let unsized = icon.nsImage
        let sized = icon.nsImage(size: 20)
        XCTAssertNotNil(unsized)
        XCTAssertNotNil(sized)
        XCTAssertTrue(unsized?.isTemplate == true, "Unsized cached image must have isTemplate == true")
        XCTAssertTrue(sized?.isTemplate == true, "Sized cached image must have isTemplate == true")
    }
}
#endif
