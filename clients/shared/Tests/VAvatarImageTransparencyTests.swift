import XCTest
@testable import VellumAssistantShared

#if canImport(AppKit) && !targetEnvironment(macCatalyst)
import AppKit

final class VAvatarImageTransparencyTests: XCTestCase {

    // MARK: - Helpers

    /// Creates an NSImage of the given size filled with a solid color (fully opaque).
    private func makeOpaqueImage(width: Int, height: Int) -> NSImage {
        let image = NSImage(size: NSSize(width: width, height: height))
        image.lockFocus()
        NSColor.blue.setFill()
        NSRect(x: 0, y: 0, width: width, height: height).fill()
        image.unlockFocus()
        return image
    }

    /// Creates an NSImage of the given size with a fully transparent background.
    private func makeTransparentImage(width: Int, height: Int) -> NSImage {
        let image = NSImage(size: NSSize(width: width, height: height))
        image.lockFocus()
        NSColor.clear.setFill()
        NSRect(x: 0, y: 0, width: width, height: height).fill()
        image.unlockFocus()
        return image
    }

    /// Creates an NSImage with a transparent background and an opaque center circle,
    /// so corners are transparent but the center is not.
    private func makeTransparentCornersImage(width: Int, height: Int) -> NSImage {
        let image = NSImage(size: NSSize(width: width, height: height))
        image.lockFocus()
        NSColor.clear.setFill()
        NSRect(x: 0, y: 0, width: width, height: height).fill()
        // Fill center area with opaque color
        NSColor.red.setFill()
        let inset = Double(min(width, height)) * 0.25
        NSBezierPath(ovalIn: NSRect(
            x: inset, y: inset,
            width: Double(width) - inset * 2,
            height: Double(height) - inset * 2
        )).fill()
        image.unlockFocus()
        return image
    }

    // MARK: - Core detection

    /// A fully opaque image must be detected as non-transparent.
    func testOpaqueImageDetectedAsNonTransparent() {
        let image = makeOpaqueImage(width: 100, height: 100)
        XCTAssertFalse(
            VAvatarImage.imageHasTransparency(image),
            "Fully opaque image should not be detected as transparent"
        )
    }

    /// A fully transparent image must be detected as transparent.
    func testTransparentImageDetectedAsTransparent() {
        let image = makeTransparentImage(width: 100, height: 100)
        XCTAssertTrue(
            VAvatarImage.imageHasTransparency(image),
            "Fully transparent image should be detected as transparent"
        )
    }

    /// An image with transparent corners (like a character avatar) must be
    /// detected as transparent since corners are among the 8 sample points.
    func testTransparentCornersDetectedAsTransparent() {
        let image = makeTransparentCornersImage(width: 200, height: 200)
        XCTAssertTrue(
            VAvatarImage.imageHasTransparency(image),
            "Image with transparent corners should be detected as transparent"
        )
    }

    // MARK: - Caching via objc_setAssociatedObject

    /// Calling imageHasTransparency twice with the same NSImage instance must
    /// return the same result (verifying the cache doesn't corrupt the value).
    func testCachedResultMatchesInitialResult() {
        let opaqueImage = makeOpaqueImage(width: 50, height: 50)
        let first = VAvatarImage.imageHasTransparency(opaqueImage)
        let second = VAvatarImage.imageHasTransparency(opaqueImage)
        XCTAssertEqual(first, second, "Cached result should match initial computation")
        XCTAssertFalse(first, "Opaque image should remain non-transparent after caching")

        let transparentImage = makeTransparentImage(width: 50, height: 50)
        let firstT = VAvatarImage.imageHasTransparency(transparentImage)
        let secondT = VAvatarImage.imageHasTransparency(transparentImage)
        XCTAssertEqual(firstT, secondT, "Cached result should match initial computation")
        XCTAssertTrue(firstT, "Transparent image should remain transparent after caching")
    }

    // MARK: - Large image downsampling

    /// A large opaque image must still be correctly detected after downsampling.
    func testLargeOpaqueImageDownsampledCorrectly() {
        let image = makeOpaqueImage(width: 4000, height: 4000)
        XCTAssertFalse(
            VAvatarImage.imageHasTransparency(image),
            "Large opaque image should still be detected as non-transparent after downsampling"
        )
    }

    /// A large transparent image must still be correctly detected after downsampling.
    func testLargeTransparentImageDownsampledCorrectly() {
        let image = makeTransparentImage(width: 4000, height: 4000)
        XCTAssertTrue(
            VAvatarImage.imageHasTransparency(image),
            "Large transparent image should still be detected as transparent after downsampling"
        )
    }

    // MARK: - Edge cases

    /// A 1x1 opaque image should be handled without error.
    func testMinimalOpaqueImage() {
        let image = makeOpaqueImage(width: 1, height: 1)
        XCTAssertFalse(
            VAvatarImage.imageHasTransparency(image),
            "1x1 opaque image should not be detected as transparent"
        )
    }

    /// A 1x1 transparent image should be handled without error.
    func testMinimalTransparentImage() {
        let image = makeTransparentImage(width: 1, height: 1)
        XCTAssertTrue(
            VAvatarImage.imageHasTransparency(image),
            "1x1 transparent image should be detected as transparent"
        )
    }

    /// Images at exactly the maxSamplingDimension should not be downsampled.
    func testImageAtMaxSamplingDimensionNotDownsampled() {
        let dim = VAvatarImage.maxSamplingDimension
        let image = makeOpaqueImage(width: dim, height: dim)
        XCTAssertFalse(
            VAvatarImage.imageHasTransparency(image),
            "Image at exactly maxSamplingDimension should be correctly detected"
        )
    }

    /// The alphaOpaqueThreshold constant should be 243 (ceil(0.95 * 255)).
    func testAlphaOpaqueThresholdValue() {
        XCTAssertEqual(
            VAvatarImage.alphaOpaqueThreshold, 243,
            "alphaOpaqueThreshold should be ceil(0.95 * 255) = 243"
        )
    }
}
#elseif canImport(UIKit)
import UIKit

final class VAvatarImageTransparencyTests: XCTestCase {

    // MARK: - Helpers

    /// Creates a UIImage of the given size filled with a solid color (fully opaque).
    private func makeOpaqueImage(width: Int, height: Int) -> UIImage {
        let format = UIGraphicsImageRendererFormat()
        format.scale = 1
        let renderer = UIGraphicsImageRenderer(size: CGSize(width: width, height: height), format: format)
        return renderer.image { context in
            UIColor.blue.setFill()
            context.fill(CGRect(x: 0, y: 0, width: width, height: height))
        }
    }

    /// Creates a UIImage of the given size with a fully transparent background.
    private func makeTransparentImage(width: Int, height: Int) -> UIImage {
        let format = UIGraphicsImageRendererFormat()
        format.scale = 1
        let renderer = UIGraphicsImageRenderer(size: CGSize(width: width, height: height), format: format)
        return renderer.image { context in
            UIColor.clear.setFill()
            context.fill(CGRect(x: 0, y: 0, width: width, height: height))
        }
    }

    /// Creates a UIImage with a transparent background and an opaque center circle,
    /// so corners are transparent but the center is not.
    private func makeTransparentCornersImage(width: Int, height: Int) -> UIImage {
        let format = UIGraphicsImageRendererFormat()
        format.scale = 1
        let renderer = UIGraphicsImageRenderer(size: CGSize(width: width, height: height), format: format)
        return renderer.image { context in
            UIColor.clear.setFill()
            context.fill(CGRect(x: 0, y: 0, width: width, height: height))
            let inset = Double(min(width, height)) * 0.25
            UIColor.red.setFill()
            context.cgContext.fillEllipse(in: CGRect(
                x: inset, y: inset,
                width: Double(width) - inset * 2,
                height: Double(height) - inset * 2
            ))
        }
    }

    // MARK: - Core detection

    /// A fully opaque image must be detected as non-transparent.
    func testOpaqueImageDetectedAsNonTransparent() {
        let image = makeOpaqueImage(width: 100, height: 100)
        XCTAssertFalse(
            VAvatarImage.imageHasTransparency(image),
            "Fully opaque image should not be detected as transparent"
        )
    }

    /// A fully transparent image must be detected as transparent.
    func testTransparentImageDetectedAsTransparent() {
        let image = makeTransparentImage(width: 100, height: 100)
        XCTAssertTrue(
            VAvatarImage.imageHasTransparency(image),
            "Fully transparent image should be detected as transparent"
        )
    }

    /// An image with transparent corners (like a character avatar) must be
    /// detected as transparent since corners are among the 8 sample points.
    func testTransparentCornersDetectedAsTransparent() {
        let image = makeTransparentCornersImage(width: 200, height: 200)
        XCTAssertTrue(
            VAvatarImage.imageHasTransparency(image),
            "Image with transparent corners should be detected as transparent"
        )
    }

    // MARK: - Caching via objc_setAssociatedObject

    /// Calling imageHasTransparency twice with the same UIImage instance must
    /// return the same result (verifying the cache doesn't corrupt the value).
    func testCachedResultMatchesInitialResult() {
        let opaqueImage = makeOpaqueImage(width: 50, height: 50)
        let first = VAvatarImage.imageHasTransparency(opaqueImage)
        let second = VAvatarImage.imageHasTransparency(opaqueImage)
        XCTAssertEqual(first, second, "Cached result should match initial computation")
        XCTAssertFalse(first, "Opaque image should remain non-transparent after caching")

        let transparentImage = makeTransparentImage(width: 50, height: 50)
        let firstT = VAvatarImage.imageHasTransparency(transparentImage)
        let secondT = VAvatarImage.imageHasTransparency(transparentImage)
        XCTAssertEqual(firstT, secondT, "Cached result should match initial computation")
        XCTAssertTrue(firstT, "Transparent image should remain transparent after caching")
    }

    // MARK: - Large image downsampling

    /// A large opaque image must still be correctly detected after downsampling.
    func testLargeOpaqueImageDownsampledCorrectly() {
        let image = makeOpaqueImage(width: 4000, height: 4000)
        XCTAssertFalse(
            VAvatarImage.imageHasTransparency(image),
            "Large opaque image should still be detected as non-transparent after downsampling"
        )
    }

    /// A large transparent image must still be correctly detected after downsampling.
    func testLargeTransparentImageDownsampledCorrectly() {
        let image = makeTransparentImage(width: 4000, height: 4000)
        XCTAssertTrue(
            VAvatarImage.imageHasTransparency(image),
            "Large transparent image should still be detected as transparent after downsampling"
        )
    }

    // MARK: - Edge cases

    /// A 1x1 opaque image should be handled without error.
    func testMinimalOpaqueImage() {
        let image = makeOpaqueImage(width: 1, height: 1)
        XCTAssertFalse(
            VAvatarImage.imageHasTransparency(image),
            "1x1 opaque image should not be detected as transparent"
        )
    }

    /// A 1x1 transparent image should be handled without error.
    func testMinimalTransparentImage() {
        let image = makeTransparentImage(width: 1, height: 1)
        XCTAssertTrue(
            VAvatarImage.imageHasTransparency(image),
            "1x1 transparent image should be detected as transparent"
        )
    }

    /// Images at exactly the maxSamplingDimension should not be downsampled.
    func testImageAtMaxSamplingDimensionNotDownsampled() {
        let dim = VAvatarImage.maxSamplingDimension
        let image = makeOpaqueImage(width: dim, height: dim)
        XCTAssertFalse(
            VAvatarImage.imageHasTransparency(image),
            "Image at exactly maxSamplingDimension should be correctly detected"
        )
    }

    /// The alphaOpaqueThreshold constant should be 243 (ceil(0.95 * 255)).
    func testAlphaOpaqueThresholdValue() {
        XCTAssertEqual(
            VAvatarImage.alphaOpaqueThreshold, 243,
            "alphaOpaqueThreshold should be ceil(0.95 * 255) = 243"
        )
    }
}
#endif
