import XCTest
@testable import VellumAssistantLib
@testable import VellumAssistantShared

// MARK: - Mock URLProtocol

/// Intercepts all requests in the mock session so tests never hit the network.
private class MockURLProtocol: URLProtocol {
    static var requestHandler: ((URLRequest) throws -> (HTTPURLResponse, Data))?

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        guard let handler = MockURLProtocol.requestHandler else {
            client?.urlProtocol(self, didFailWithError: URLError(.unknown))
            return
        }
        do {
            let (response, data) = try handler(request)
            client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
            client?.urlProtocol(self, didLoad: data)
            client?.urlProtocolDidFinishLoading(self)
        } catch {
            client?.urlProtocol(self, didFailWithError: error)
        }
    }

    override func stopLoading() {}
}

// MARK: - Tests

@MainActor
final class MediaEmbedResolverMIMEProbeIntegrationTests: XCTestCase {

    private var mockSession: URLSession!
    private var mockProbe: ImageMIMEProbe!

    override func setUp() {
        super.setUp()
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [MockURLProtocol.self]
        mockSession = URLSession(configuration: config)
        mockProbe = ImageMIMEProbe(session: mockSession)
    }

    override func tearDown() {
        MockURLProtocol.requestHandler = nil
        mockProbe = nil
        mockSession = nil
        super.tearDown()
    }

    // MARK: - Helpers

    private func makeMessage(
        _ text: String,
        role: ChatRole = .assistant,
        timestamp: Date = Date()
    ) -> ChatMessage {
        ChatMessage(role: role, text: text, timestamp: timestamp)
    }

    private func enabledSettings(
        enabledSince: Date? = nil,
        allowedDomains: [String] = [
            "youtube.com", "youtu.be",
            "vimeo.com",
            "loom.com",
        ]
    ) -> MediaEmbedResolverSettings {
        MediaEmbedResolverSettings(
            enabled: true,
            enabledSince: enabledSince,
            allowedDomains: allowedDomains
        )
    }

    /// Resolves intents using the mock probe instead of the shared singleton,
    /// so tests never touch the network.
    private func resolveWithMockProbe(
        message: ChatMessage,
        settings: MediaEmbedResolverSettings
    ) async -> [MediaEmbedIntent] {
        guard settings.enabled else { return [] }

        if let enabledSince = settings.enabledSince,
           message.timestamp < enabledSince {
            return []
        }

        let urls = MessageURLExtractor.extractAllURLs(from: message.text)
        guard !urls.isEmpty else { return [] }

        var seen = Set<String>()
        var intents: [MediaEmbedIntent] = []

        for url in urls {
            // Video parsing (same as the resolver)
            let videoParsers: [(URL) -> VideoParseResult?] = [
                YouTubeParser.parse,
                VimeoParser.parse,
                LoomParser.parse,
            ]
            var isVideo = false
            for parser in videoParsers {
                if let result = parser(url) {
                    if DomainAllowlistMatcher.isAllowed(result.embedURL, allowedDomains: settings.allowedDomains) {
                        let canonical = result.embedURL.absoluteString
                        if !seen.contains(canonical) {
                            seen.insert(canonical)
                            intents.append(.video(
                                provider: result.provider,
                                videoID: result.videoID,
                                embedURL: result.embedURL
                            ))
                        }
                    }
                    isVideo = true
                    break
                }
            }
            if isVideo { continue }

            // Two-stage image detection with the mock probe
            let classification = ImageURLClassifier.classify(url)
            if classification == .image {
                let canonical = url.absoluteString
                if !seen.contains(canonical) {
                    seen.insert(canonical)
                    intents.append(.image(url: url))
                }
            } else if classification == .unknown {
                let probeResult = await mockProbe.probe(url)
                if probeResult == .image {
                    let canonical = url.absoluteString
                    if !seen.contains(canonical) {
                        seen.insert(canonical)
                        intents.append(.image(url: url))
                    }
                }
            }
        }

        return intents
    }

    // MARK: - Extensionless URL with image MIME type produces image intent

    func testExtensionlessURLWithImageMIMEProducesImageIntent() async {
        MockURLProtocol.requestHandler = { request in
            XCTAssertEqual(request.httpMethod, "HEAD")
            let response = HTTPURLResponse(
                url: request.url!,
                statusCode: 200,
                httpVersion: nil,
                headerFields: ["Content-Type": "image/png"]
            )!
            return (response, Data())
        }

        let message = makeMessage("Check this: https://cdn.example.com/photo")
        let intents = await resolveWithMockProbe(
            message: message,
            settings: enabledSettings()
        )

        XCTAssertEqual(intents.count, 1, "Extensionless URL serving image/png should produce one intent")
        if case .image(let url) = intents.first {
            XCTAssertEqual(url.absoluteString, "https://cdn.example.com/photo")
        } else {
            XCTFail("Expected image intent for extensionless URL with image MIME")
        }
    }

    // MARK: - Extensionless URL with non-image MIME type produces no intent

    func testExtensionlessURLWithHTMLMIMEProducesNoIntent() async {
        MockURLProtocol.requestHandler = { request in
            let response = HTTPURLResponse(
                url: request.url!,
                statusCode: 200,
                httpVersion: nil,
                headerFields: ["Content-Type": "text/html"]
            )!
            return (response, Data())
        }

        let message = makeMessage("Visit https://example.com/page")
        let intents = await resolveWithMockProbe(
            message: message,
            settings: enabledSettings()
        )

        XCTAssertEqual(intents, [], "Extensionless URL serving text/html should produce no intents")
    }

    // MARK: - Extension-based classification still works (no regression)

    func testExtensionBasedClassificationStillWorks() async {
        // No mock handler needed — extension-based URLs should never hit the probe.
        var wasCalled = false
        MockURLProtocol.requestHandler = { _ in
            wasCalled = true
            let response = HTTPURLResponse(
                url: URL(string: "https://example.com")!,
                statusCode: 200,
                httpVersion: nil,
                headerFields: ["Content-Type": "text/html"]
            )!
            return (response, Data())
        }

        let message = makeMessage("Screenshot: https://cdn.example.com/screenshot.png")
        let intents = await resolveWithMockProbe(
            message: message,
            settings: enabledSettings()
        )

        XCTAssertEqual(intents.count, 1, "Extension-based .png URL should still produce image intent")
        if case .image(let url) = intents.first {
            XCTAssertEqual(url.absoluteString, "https://cdn.example.com/screenshot.png")
        } else {
            XCTFail("Expected image intent for .png URL")
        }
        XCTAssertFalse(wasCalled, "MIME probe should not be called for URLs with recognized extensions")
    }

    // MARK: - Mixed: extension-based image + extensionless image + video

    func testMixedExtensionAndExtensionlessAndVideo() async {
        MockURLProtocol.requestHandler = { request in
            // Only the extensionless URL should hit the probe
            let response = HTTPURLResponse(
                url: request.url!,
                statusCode: 200,
                httpVersion: nil,
                headerFields: ["Content-Type": "image/jpeg"]
            )!
            return (response, Data())
        }

        let message = makeMessage(
            "Image: https://cdn.example.com/pic.jpg " +
            "CDN: https://cdn.example.com/media123 " +
            "Video: https://www.youtube.com/watch?v=test1"
        )
        let intents = await resolveWithMockProbe(
            message: message,
            settings: enabledSettings()
        )

        XCTAssertEqual(intents.count, 3, "Should resolve extension image + probed image + video")

        // First: extension-based image
        if case .image(let url) = intents[0] {
            XCTAssertTrue(url.absoluteString.contains("pic.jpg"))
        } else {
            XCTFail("Expected image intent for .jpg URL at index 0")
        }

        // Second: MIME-probed extensionless image
        if case .image(let url) = intents[1] {
            XCTAssertTrue(url.absoluteString.contains("media123"))
        } else {
            XCTFail("Expected image intent for extensionless URL at index 1")
        }

        // Third: video
        if case .video(let provider, let videoID, _) = intents[2] {
            XCTAssertEqual(provider, "youtube")
            XCTAssertEqual(videoID, "test1")
        } else {
            XCTFail("Expected video intent at index 2")
        }
    }

    // MARK: - MIME probe network error does not produce intent

    func testMIMEProbeNetworkErrorProducesNoIntent() async {
        MockURLProtocol.requestHandler = { _ in
            throw URLError(.notConnectedToInternet)
        }

        let message = makeMessage("Check https://cdn.example.com/mystery")
        let intents = await resolveWithMockProbe(
            message: message,
            settings: enabledSettings()
        )

        XCTAssertEqual(intents, [], "Network error during MIME probe should not produce an intent")
    }

    // MARK: - Extensionless URL deduplication

    func testExtensionlessURLDeduplication() async {
        MockURLProtocol.requestHandler = { request in
            let response = HTTPURLResponse(
                url: request.url!,
                statusCode: 200,
                httpVersion: nil,
                headerFields: ["Content-Type": "image/webp"]
            )!
            return (response, Data())
        }

        let message = makeMessage(
            "https://cdn.example.com/photo https://cdn.example.com/photo"
        )
        let intents = await resolveWithMockProbe(
            message: message,
            settings: enabledSettings()
        )

        XCTAssertEqual(intents.count, 1, "Duplicate extensionless URLs should be deduplicated")
    }
}
