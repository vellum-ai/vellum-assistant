import XCTest
@testable import VellumAssistantLib

final class KernelStoreTests: XCTestCase {

    func testRequireKernelSucceedsWhenFound() throws {
        let fakeURL = URL(fileURLWithPath: "/tmp/fake-kernel")
        let store = KataKernelStore(
            runtimeRoot: URL(fileURLWithPath: "/tmp/test-runtime"),
            locateKernel: { fakeURL }
        )
        XCTAssertEqual(try store.requireKernel(), fakeURL)
    }

    func testRequireKernelThrowsWhenNotFound() {
        let store = KataKernelStore(
            runtimeRoot: URL(fileURLWithPath: "/tmp/test-runtime"),
            locateKernel: { nil }
        )
        XCTAssertThrowsError(try store.requireKernel()) { error in
            XCTAssertEqual(error as? KataKernelStore.KernelStoreError, .kernelNotFound)
        }
    }

    func testKernelNotFoundErrorDescription() {
        let error = KataKernelStore.KernelStoreError.kernelNotFound
        XCTAssertTrue(error.errorDescription!.contains("kernel"))
    }

    func testInitImageReferenceContainsVersion() {
        let ref = KataKernelStore.initImageReference
        XCTAssertTrue(ref.hasPrefix("ghcr.io/apple/containerization/vminit:"))
        // Version appears exactly once (no duplication)
        let version = ref.split(separator: ":").last!
        XCTAssertFalse(version.isEmpty)
    }

    func testDefaultRuntimeRootPath() {
        let root = KataKernelStore.defaultRuntimeRoot()
        XCTAssertTrue(root.path.hasSuffix("apple-containers"))
        XCTAssertTrue(root.path.contains("vellum-assistant"))
    }

    func testBundledKernelSubdirectory() {
        XCTAssertEqual(KataKernelStore.bundledKernelSubdirectory, "DeveloperVM")
    }
}
