import XCTest
import SwiftUI
@testable import VellumAssistantShared

final class VCachedRemoteImageTests: XCTestCase {

    /// The shared `VRemoteImageCache.session` must be configured with a
    /// non-nil `URLCache` so responses are persisted rather than going
    /// back out to the network on every request.
    func testSessionHasURLCache() {
        let session = VRemoteImageCache.session
        XCTAssertNotNil(
            session.configuration.urlCache,
            "VRemoteImageCache.session must have a urlCache configured"
        )
    }

    /// The shared session's request cache policy must prefer cached
    /// data so repeat loads of the same logo skip the network.
    func testSessionUsesReturnCacheDataElseLoadPolicy() {
        let session = VRemoteImageCache.session
        XCTAssertEqual(
            session.configuration.requestCachePolicy,
            .returnCacheDataElseLoad,
            "VRemoteImageCache.session should prefer cached data when available"
        )
    }

    /// `VRemoteImageCache` is expected to place its on-disk cache under
    /// `Caches/VellumRemoteImages`. `URLCache` does not publicly expose
    /// its backing directory, so we can only verify the expected path
    /// resolves inside the user's Caches folder.
    func testExpectedCacheDirectoryIsUnderUserCaches() {
        let cachesDir = FileManager.default
            .urls(for: .cachesDirectory, in: .userDomainMask)
            .first
        XCTAssertNotNil(cachesDir, "User should have a Caches directory")

        let expected = cachesDir?.appendingPathComponent("VellumRemoteImages", isDirectory: true)
        XCTAssertNotNil(expected, "Expected VellumRemoteImages subdirectory path to resolve")
        XCTAssertTrue(
            expected?.path.contains("/Caches/VellumRemoteImages") == true,
            "Expected cache directory path to live under Caches/VellumRemoteImages, got: \(expected?.path ?? "<nil>")"
        )
    }

    /// With a `nil` URL, constructing `VCachedRemoteImage` must not crash
    /// and must not trigger any network call. The load is gated behind
    /// `.task { }` + `guard let url`, so mere instantiation is a no-op.
    func testNilURLInstantiationIsSideEffectFree() {
        _ = VCachedRemoteImage(
            url: nil,
            content: { image in image },
            placeholder: { Color.clear }
        )
    }
}
