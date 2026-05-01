import XCTest

@testable import VellumAssistantShared

// MARK: - URLProtocol stub for unified job-status calls

private final class JobStatusURLProtocol: URLProtocol {
    static var requestHandler: ((URLRequest) throws -> (HTTPURLResponse, Data))?

    override class func canInit(with request: URLRequest) -> Bool {
        true
    }

    override class func canonicalRequest(for request: URLRequest) -> URLRequest {
        request
    }

    override func startLoading() {
        guard let handler = Self.requestHandler else {
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
final class PlatformMigrationClientPollJobStatusTests: XCTestCase {
    private var previousToken: String?

    override func setUp() {
        super.setUp()
        JobStatusURLProtocol.requestHandler = nil
        URLProtocol.registerClass(JobStatusURLProtocol.self)
        // Save any existing token so we can restore it in tearDown, preventing
        // a test-abort from leaving a bogus token in the real credential store.
        previousToken = SessionTokenManager.getToken()
        // Provide a token so network-path tests reach the stub handler rather than
        // short-circuiting with notAuthenticated before any request is made.
        SessionTokenManager.setToken("test-session-token")
    }

    override func tearDown() {
        URLProtocol.unregisterClass(JobStatusURLProtocol.self)
        JobStatusURLProtocol.requestHandler = nil
        if let token = previousToken {
            SessionTokenManager.setToken(token)
        } else {
            SessionTokenManager.deleteToken()
        }
        previousToken = nil
        super.tearDown()
    }

    private func stubOK(body: String) {
        JobStatusURLProtocol.requestHandler = { request in
            let response = HTTPURLResponse(
                url: request.url!,
                statusCode: 200,
                httpVersion: nil,
                headerFields: nil
            )!
            return (response, Data(body.utf8))
        }
    }

    func testPollJobStatusUsesUnifiedJobsPath() async throws {
        let observed = ObservedRequest()
        JobStatusURLProtocol.requestHandler = { request in
            observed.url = request.url
            observed.method = request.httpMethod
            let response = HTTPURLResponse(
                url: request.url!,
                statusCode: 200,
                httpVersion: nil,
                headerFields: nil
            )!
            return (response, Data(#"{"status":"pending"}"#.utf8))
        }

        _ = try await PlatformMigrationClient.pollJobStatus(jobId: "test-job-id")

        let url = try XCTUnwrap(observed.url)
        XCTAssertTrue(
            url.absoluteString.hasSuffix("/v1/migrations/jobs/test-job-id/"),
            "Expected URL to end with unified jobs path; got \(url.absoluteString)"
        )
        XCTAssertEqual(observed.method, "GET")
    }

    func testPollJobStatusDecodesPending() async throws {
        stubOK(body: #"{"status":"pending","job_id":"job-1"}"#)
        let status = try await PlatformMigrationClient.pollJobStatus(jobId: "job-1")
        XCTAssertEqual(status.status, "pending")
        XCTAssertEqual(status.jobId, "job-1")
        XCTAssertNil(status.error)
        XCTAssertNil(status.resultData)
    }

    func testPollJobStatusDecodesProcessing() async throws {
        stubOK(body: #"{"status":"processing","job_id":"job-2"}"#)
        let status = try await PlatformMigrationClient.pollJobStatus(jobId: "job-2")
        XCTAssertEqual(status.status, "processing")
        XCTAssertEqual(status.jobId, "job-2")
        XCTAssertNil(status.error)
        XCTAssertNil(status.resultData)
    }

    func testPollJobStatusDecodesComplete() async throws {
        stubOK(body: #"{"status":"complete","job_id":"job-3","result":{"foo":"bar"}}"#)
        let status = try await PlatformMigrationClient.pollJobStatus(jobId: "job-3")
        XCTAssertEqual(status.status, "complete")
        XCTAssertEqual(status.jobId, "job-3")
        XCTAssertNotNil(status.resultData, "Expected resultData to be re-serialized when result is present")
    }

    func testPollJobStatusDecodesFailed() async throws {
        stubOK(body: #"{"status":"failed","job_id":"job-4","error":"boom"}"#)
        let status = try await PlatformMigrationClient.pollJobStatus(jobId: "job-4")
        XCTAssertEqual(status.status, "failed")
        XCTAssertEqual(status.error, "boom")
    }

    func testPollJobStatusThrowsOnNon200() async {
        JobStatusURLProtocol.requestHandler = { request in
            let response = HTTPURLResponse(
                url: request.url!,
                statusCode: 404,
                httpVersion: nil,
                headerFields: nil
            )!
            return (response, Data(#"{"detail":"not found"}"#.utf8))
        }

        do {
            _ = try await PlatformMigrationClient.pollJobStatus(jobId: "missing-job")
            XCTFail("Expected requestFailed to be thrown")
        } catch let error as PlatformMigrationClient.PlatformMigrationError {
            if case .requestFailed(let statusCode, _) = error {
                XCTAssertEqual(statusCode, 404)
            } else {
                XCTFail("Expected .requestFailed, got \(error)")
            }
        } catch {
            XCTFail("Unexpected error type: \(error)")
        }
    }
}

// Captures observed request fields from the stub closure without violating
// `@Sendable` constraints on the URLProtocol handler.
private final class ObservedRequest: @unchecked Sendable {
    var url: URL?
    var method: String?
    var body: Data?
    var sessionTokenHeader: String?
}

@MainActor
final class PlatformMigrationClientSignedUploadUrlTests: XCTestCase {
    private var previousToken: String?

    override func setUp() {
        super.setUp()
        JobStatusURLProtocol.requestHandler = nil
        URLProtocol.registerClass(JobStatusURLProtocol.self)
        previousToken = SessionTokenManager.getToken()
        SessionTokenManager.setToken("test-session-token")
    }

    override func tearDown() {
        URLProtocol.unregisterClass(JobStatusURLProtocol.self)
        JobStatusURLProtocol.requestHandler = nil
        if let token = previousToken {
            SessionTokenManager.setToken(token)
        } else {
            SessionTokenManager.deleteToken()
        }
        previousToken = nil
        super.tearDown()
    }

    func testRequestSignedUploadUrlPostsToUnifiedEndpointWithOperationUpload() async throws {
        let observed = ObservedRequest()
        JobStatusURLProtocol.requestHandler = { request in
            observed.url = request.url
            observed.method = request.httpMethod
            observed.sessionTokenHeader = request.value(forHTTPHeaderField: "X-Session-Token")
            if let stream = request.httpBodyStream {
                observed.body = Self.readAll(from: stream)
            } else {
                observed.body = request.httpBody
            }
            let response = HTTPURLResponse(
                url: request.url!,
                statusCode: 201,
                httpVersion: nil,
                headerFields: nil
            )!
            let body = #"{"url":"https://storage.googleapis.com/signed-put?x=1","bundle_key":"uploads/org-123/abc.vbundle","expires_at":"2026-05-01T00:00:00Z"}"#
            return (response, Data(body.utf8))
        }

        let resp = try await PlatformMigrationClient.requestSignedUploadUrl()

        let url = try XCTUnwrap(observed.url)
        XCTAssertTrue(
            url.absoluteString.hasSuffix("/v1/migrations/signed-url/"),
            "Expected URL to end with unified signed-url path; got \(url.absoluteString)"
        )
        XCTAssertEqual(observed.method, "POST")
        XCTAssertEqual(observed.sessionTokenHeader, "test-session-token")

        let bodyData = try XCTUnwrap(observed.body)
        let bodyJson = try XCTUnwrap(
            try JSONSerialization.jsonObject(with: bodyData) as? [String: Any]
        )
        XCTAssertEqual(bodyJson["operation"] as? String, "upload")
        XCTAssertNil(bodyJson["bundle_key"], "upload requests must omit bundle_key")

        XCTAssertEqual(resp.uploadUrl, "https://storage.googleapis.com/signed-put?x=1")
        XCTAssertEqual(resp.bundleKey, "uploads/org-123/abc.vbundle")
        XCTAssertEqual(resp.expiresAt, "2026-05-01T00:00:00Z")
    }

    func testRequestSignedUploadUrlMapsUnavailableStatusesToSignedUrlsNotAvailable() async {
        for statusCode in [404, 503] {
            await assertMapsToSignedUrlsNotAvailable(statusCode: statusCode)
        }
    }

    private func assertMapsToSignedUrlsNotAvailable(
        statusCode: Int,
        file: StaticString = #file,
        line: UInt = #line
    ) async {
        JobStatusURLProtocol.requestHandler = { request in
            let response = HTTPURLResponse(
                url: request.url!,
                statusCode: statusCode,
                httpVersion: nil,
                headerFields: nil
            )!
            return (response, Data(#"{"detail":"unavailable"}"#.utf8))
        }

        do {
            _ = try await PlatformMigrationClient.requestSignedUploadUrl()
            XCTFail("Expected signedUrlsNotAvailable for status \(statusCode)", file: file, line: line)
        } catch let error as PlatformMigrationClient.PlatformMigrationError {
            if case .signedUrlsNotAvailable = error {
                // expected
            } else {
                XCTFail("Expected .signedUrlsNotAvailable for status \(statusCode), got \(error)", file: file, line: line)
            }
        } catch {
            XCTFail("Unexpected error type for status \(statusCode): \(error)", file: file, line: line)
        }
    }

    private static func readAll(from stream: InputStream) -> Data {
        stream.open()
        defer { stream.close() }
        var data = Data()
        let buffer = UnsafeMutablePointer<UInt8>.allocate(capacity: 4096)
        defer { buffer.deallocate() }
        while stream.hasBytesAvailable {
            let read = stream.read(buffer, maxLength: 4096)
            if read <= 0 { break }
            data.append(buffer, count: read)
        }
        return data
    }
}
