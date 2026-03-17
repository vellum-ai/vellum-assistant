import XCTest
@testable import VellumAssistantLib
@testable import VellumAssistantShared

final class VellumAppSchemeHandlerTests: XCTestCase {

    func testUserAppsDirectoryHonorsBaseDataDir() {
        let url = VellumAppSchemeHandler.resolveUserAppsDirectory(environment: [
            "BASE_DATA_DIR": "/tmp/vellum-instance"
        ])

        XCTAssertEqual(url.path, "/tmp/vellum-instance/.vellum/workspace/data/apps")
    }
}
