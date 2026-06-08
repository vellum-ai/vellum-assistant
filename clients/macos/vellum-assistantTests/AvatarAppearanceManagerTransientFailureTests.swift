import XCTest
@testable import VellumAssistantLib

/// Tests for the bootstrap-window amplifier fix in avatar fetches: transient
/// failures (401 during auth race, 5xx backend hiccup, transport/network
/// error) must not clear cached state. Only an authoritative 404 from the
/// daemon counts as "no avatar exists" and clears cached state.
@MainActor
final class AvatarAppearanceManagerTransientFailureTests: XCTestCase {

    // MARK: - isAuthoritativeAbsence

    func test404CountsAsAuthoritativeAbsence() {
        XCTAssertTrue(AvatarAppearanceManager.isAuthoritativeAbsence(statusCode: 404))
    }

    func test401DoesNotCountAsAuthoritativeAbsence() {
        // 401 during the bootstrap auth race is the exact scenario the fix
        // addresses — an expired/missing token triggers the retry interceptor,
        // and we must not wipe the cached avatar while that's happening.
        XCTAssertFalse(AvatarAppearanceManager.isAuthoritativeAbsence(statusCode: 401))
    }

    func test403DoesNotCountAsAuthoritativeAbsence() {
        // 403 can mean the gateway is still locking out new tokens after a
        // re-bootstrap; same preserve-and-retry policy as 401.
        XCTAssertFalse(AvatarAppearanceManager.isAuthoritativeAbsence(statusCode: 403))
    }

    func test5xxDoesNotCountAsAuthoritativeAbsence() {
        for status in [500, 502, 503, 504] {
            XCTAssertFalse(
                AvatarAppearanceManager.isAuthoritativeAbsence(statusCode: status),
                "HTTP \(status) is a backend hiccup, not an authoritative absence"
            )
        }
    }

    func test2xxNotTreatedAsAbsence() {
        // 2xx means the caller should not reach the absence check at all,
        // but defensively verify.
        XCTAssertFalse(AvatarAppearanceManager.isAuthoritativeAbsence(statusCode: 200))
        XCTAssertFalse(AvatarAppearanceManager.isAuthoritativeAbsence(statusCode: 204))
    }

    func testOnlyExactly404CountsAsAbsence() {
        // No accidental broader match — e.g. 4xx as a class is NOT absence,
        // only the specific 404 "file not found" signal.
        for status in [400, 402, 405, 410, 429] {
            XCTAssertFalse(
                AvatarAppearanceManager.isAuthoritativeAbsence(statusCode: status),
                "Only 404 should be treated as authoritative absence; HTTP \(status) is not"
            )
        }
    }

    // MARK: - AvatarState decoding

    func testDecodesCharacterState() throws {
        let json = """
        {"kind":"character","traits":{"bodyShape":"round","eyeStyle":"dot","color":"forest"},"source":"builder","image":null}
        """.data(using: .utf8)!
        let state = try JSONDecoder().decode(AvatarAppearanceManager.AvatarState.self, from: json)
        XCTAssertEqual(state.kind, .character)
        XCTAssertEqual(state.traits, AvatarAppearanceManager.AvatarState.Traits(bodyShape: "round", eyeStyle: "dot", color: "forest"))
        XCTAssertEqual(state.source, "builder")
        XCTAssertNil(state.image)
    }

    func testDecodesImageState() throws {
        let json = """
        {"kind":"image","traits":null,"source":"upload","image":{"updatedAt":"2026-01-01T00:00:00Z","etag":"abc123"}}
        """.data(using: .utf8)!
        let state = try JSONDecoder().decode(AvatarAppearanceManager.AvatarState.self, from: json)
        XCTAssertEqual(state.kind, .image)
        XCTAssertNil(state.traits)
        XCTAssertEqual(state.source, "upload")
        XCTAssertEqual(state.image, AvatarAppearanceManager.AvatarState.ImageInfo(updatedAt: "2026-01-01T00:00:00Z", etag: "abc123"))
    }

    func testDecodesNoneState() throws {
        let json = """
        {"kind":"none","traits":null,"source":null,"image":null}
        """.data(using: .utf8)!
        let state = try JSONDecoder().decode(AvatarAppearanceManager.AvatarState.self, from: json)
        XCTAssertEqual(state.kind, .none)
        XCTAssertNil(state.traits)
        XCTAssertNil(state.source)
        XCTAssertNil(state.image)
    }

    // MARK: - stateFetchAction policy (transient vs authoritative)

    func test2xxCharacterBodyProducesApply() {
        let data = """
        {"kind":"character","traits":{"bodyShape":"round","eyeStyle":"dot","color":"forest"},"source":"builder","image":null}
        """.data(using: .utf8)!
        let action = AvatarAppearanceManager.stateFetchAction(statusCode: 200, data: data)
        guard case .apply(let state) = action else {
            return XCTFail("Expected .apply for a valid 2xx character body, got \(action)")
        }
        XCTAssertEqual(state.kind, .character)
    }

    func test2xxImageBodyProducesApply() {
        let data = """
        {"kind":"image","traits":null,"source":"upload","image":{"updatedAt":"t","etag":"e"}}
        """.data(using: .utf8)!
        let action = AvatarAppearanceManager.stateFetchAction(statusCode: 200, data: data)
        guard case .apply(let state) = action else {
            return XCTFail("Expected .apply for a valid 2xx image body, got \(action)")
        }
        XCTAssertEqual(state.kind, .image)
    }

    func test2xxNoneBodyProducesApply() {
        let data = """
        {"kind":"none","traits":null,"source":null,"image":null}
        """.data(using: .utf8)!
        let action = AvatarAppearanceManager.stateFetchAction(statusCode: 200, data: data)
        guard case .apply(let state) = action else {
            return XCTFail("Expected .apply for a valid 2xx none body, got \(action)")
        }
        XCTAssertEqual(state.kind, .none)
    }

    func test2xxEmptyBodyClears() {
        // A 2xx with no body is an authoritative "no avatar" signal.
        XCTAssertEqual(AvatarAppearanceManager.stateFetchAction(statusCode: 200, data: Data()), .clear)
    }

    func test2xxGarbledBodyClears() {
        let data = "not json".data(using: .utf8)!
        XCTAssertEqual(AvatarAppearanceManager.stateFetchAction(statusCode: 200, data: data), .clear)
    }

    func test404Clears() {
        // Authoritative absence clears cached state.
        XCTAssertEqual(AvatarAppearanceManager.stateFetchAction(statusCode: 404, data: Data()), .clear)
    }

    func testTransientStatusesPreserveAndRetry() {
        // 401 (auth race), 403, and 5xx must NOT clear cached state — they
        // schedule a retry so a brief bootstrap hiccup doesn't wipe a good avatar.
        for status in [401, 403, 500, 502, 503, 504] {
            XCTAssertEqual(
                AvatarAppearanceManager.stateFetchAction(statusCode: status, data: Data()),
                .retry,
                "HTTP \(status) should preserve cached state and retry"
            )
        }
    }

    func testNonAbsence4xxPreserveAndRetry() {
        // Only 404 is authoritative absence; other 4xx are transient.
        for status in [400, 402, 405, 410, 429] {
            XCTAssertEqual(
                AvatarAppearanceManager.stateFetchAction(statusCode: status, data: Data()),
                .retry,
                "HTTP \(status) should preserve cached state and retry"
            )
        }
    }

    // MARK: - apply* state branches

    @MainActor
    func testApplyCharacterStateSetsTraitsAndClearsImage() {
        let manager = AvatarAppearanceManager()
        let body = AvatarBodyShape.allCases.first!
        let eyes = AvatarEyeStyle.allCases.first!
        let color = AvatarColor.allCases.first!
        manager.applyCharacterState(
            AvatarAppearanceManager.AvatarState.Traits(
                bodyShape: body.rawValue,
                eyeStyle: eyes.rawValue,
                color: color.rawValue
            )
        )
        XCTAssertEqual(manager.characterBodyShape, body)
        XCTAssertEqual(manager.characterEyeStyle, eyes)
        XCTAssertEqual(manager.characterColor, color)
        XCTAssertNil(manager.customAvatarImage, "character state must clear the custom image so the animated path is used")
    }

    @MainActor
    func testApplyCharacterStateIgnoresMalformedTraits() {
        let manager = AvatarAppearanceManager()
        manager.applyCharacterState(
            AvatarAppearanceManager.AvatarState.Traits(bodyShape: "??", eyeStyle: "??", color: "??")
        )
        // Malformed traits must not partially populate state.
        XCTAssertNil(manager.characterBodyShape)
        XCTAssertNil(manager.characterEyeStyle)
        XCTAssertNil(manager.characterColor)
    }

    @MainActor
    func testApplyNoneStateClearsBoth() {
        let manager = AvatarAppearanceManager()
        let body = AvatarBodyShape.allCases.first!
        let eyes = AvatarEyeStyle.allCases.first!
        let color = AvatarColor.allCases.first!
        manager.applyCharacterState(
            AvatarAppearanceManager.AvatarState.Traits(
                bodyShape: body.rawValue,
                eyeStyle: eyes.rawValue,
                color: color.rawValue
            )
        )
        manager.applyNoneState()
        XCTAssertNil(manager.characterBodyShape)
        XCTAssertNil(manager.characterEyeStyle)
        XCTAssertNil(manager.characterColor)
        XCTAssertNil(manager.customAvatarImage)
    }
}
