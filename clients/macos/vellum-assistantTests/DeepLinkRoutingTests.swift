import XCTest
@testable import VellumAssistantLib

final class DeepLinkRoutingTests: XCTestCase {

    private let known: Set<String> = ["asst_known", "asst_other"]

    private func url(_ string: String) -> URL {
        guard let url = URL(string: string) else {
            fatalError("Invalid URL in test: \(string)")
        }
        return url
    }

    // MARK: - No assistant param (regression guard)

    func testNoAssistantParamRoutesToActive() {
        let decision = DeepLinkRouter.decide(
            url: url("vellum://send?message=hello"),
            knownAssistantIds: known,
            multiAssistantEnabled: true
        )
        XCTAssertEqual(decision, .routeToActive(message: "hello"))
    }

    func testNoAssistantParamRoutesToActiveWhenFlagOff() {
        let decision = DeepLinkRouter.decide(
            url: url("vellum://send?message=hello"),
            knownAssistantIds: known,
            multiAssistantEnabled: false
        )
        XCTAssertEqual(decision, .routeToActive(message: "hello"))
    }

    // MARK: - Known assistant id

    func testKnownAssistantWithFlagOnRequestsLiveSwitch() {
        let decision = DeepLinkRouter.decide(
            url: url("vellum://send?message=hi&assistant=asst_known"),
            knownAssistantIds: known,
            multiAssistantEnabled: true
        )
        XCTAssertEqual(decision, .switchLive(assistantId: "asst_known", message: "hi"))
    }

    func testKnownAssistantWithFlagOffDoesNotMutateStateAndRoutesToActive() {
        let decision = DeepLinkRouter.decide(
            url: url("vellum://send?message=hi&assistant=asst_known"),
            knownAssistantIds: known,
            multiAssistantEnabled: false
        )
        XCTAssertEqual(decision, .routeToActiveFlagOff(requestedAssistantId: "asst_known", message: "hi"))
    }

    // MARK: - Unknown assistant id

    func testUnknownAssistantFallsBackToActiveWithMessagePreserved() {
        let decision = DeepLinkRouter.decide(
            url: url("vellum://send?message=hi&assistant=asst_nope"),
            knownAssistantIds: known,
            multiAssistantEnabled: true
        )
        XCTAssertEqual(
            decision,
            .routeToActiveAfterUnknownAssistant(
                requestedAssistantId: "asst_nope",
                message: "hi"
            )
        )
    }

    func testUnknownAssistantFallsBackEvenWhenFlagOff() {
        let decision = DeepLinkRouter.decide(
            url: url("vellum://send?message=hi&assistant=asst_nope"),
            knownAssistantIds: known,
            multiAssistantEnabled: false
        )
        XCTAssertEqual(
            decision,
            .routeToActiveAfterUnknownAssistant(
                requestedAssistantId: "asst_nope",
                message: "hi"
            )
        )
    }

    // MARK: - Empty / missing message guard

    func testEmptyMessageIsIgnored() {
        let decision = DeepLinkRouter.decide(
            url: url("vellum://send?message=&assistant=asst_known"),
            knownAssistantIds: known,
            multiAssistantEnabled: true
        )
        XCTAssertEqual(decision, .ignore)
    }

    func testMissingMessageIsIgnored() {
        let decision = DeepLinkRouter.decide(
            url: url("vellum://send?assistant=asst_known"),
            knownAssistantIds: known,
            multiAssistantEnabled: true
        )
        XCTAssertEqual(decision, .ignore)
    }

    // MARK: - Host guard

    func testWrongHostIsIgnored() {
        let decision = DeepLinkRouter.decide(
            url: url("vellum://other?message=hi"),
            knownAssistantIds: known,
            multiAssistantEnabled: true
        )
        XCTAssertEqual(decision, .ignore)
    }

    // MARK: - Empty assistant param

    func testEmptyAssistantParamIsTreatedAsNoParam() {
        let decision = DeepLinkRouter.decide(
            url: url("vellum://send?message=hi&assistant="),
            knownAssistantIds: known,
            multiAssistantEnabled: true
        )
        XCTAssertEqual(decision, .routeToActive(message: "hi"))
    }
}
