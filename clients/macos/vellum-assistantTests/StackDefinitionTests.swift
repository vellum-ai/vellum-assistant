import XCTest
@testable import VellumAssistantLib

final class StackDefinitionTests: XCTestCase {

    // MARK: - VellumServiceName

    func testAllServicesPresent() {
        let names = VellumServiceName.allCases
        XCTAssertEqual(names.count, 3)
        XCTAssertTrue(names.contains(.assistant))
        XCTAssertTrue(names.contains(.gateway))
        XCTAssertTrue(names.contains(.credentialExecutor))
    }

    func testServiceRawValues() {
        XCTAssertEqual(VellumServiceName.assistant.rawValue, "vellum-assistant")
        XCTAssertEqual(VellumServiceName.gateway.rawValue, "vellum-gateway")
        XCTAssertEqual(VellumServiceName.credentialExecutor.rawValue, "vellum-credential-executor")
    }

    func testStartOrderContainsAllServices() {
        let ordered = Set(VellumServiceName.startOrder)
        let all = Set(VellumServiceName.allCases)
        XCTAssertEqual(ordered, all)
    }

    func testStartOrderBeginsWithAssistant() {
        XCTAssertEqual(VellumServiceName.startOrder.first, .assistant)
    }

    // MARK: - VellumImageReference

    func testFullReferenceFormat() {
        let ref = VellumImageReference(registry: "docker.io", repository: "vellumai/vellum-assistant", tag: "1.2.3")
        XCTAssertEqual(ref.fullReference, "docker.io/vellumai/vellum-assistant:1.2.3")
    }

    func testDefaultsContainAllServices() {
        let refs = VellumImageReference.defaults(version: "0.1.0")
        for service in VellumServiceName.allCases {
            XCTAssertNotNil(refs[service], "Missing default image ref for \(service)")
        }
    }

    func testDefaultsUseRequestedVersion() {
        let refs = VellumImageReference.defaults(version: "42.0.0")
        for (_, ref) in refs {
            XCTAssertEqual(ref.tag, "42.0.0")
        }
    }

    // MARK: - Ports

    func testPortValues() {
        XCTAssertEqual(VellumContainerPorts.assistantHTTP, 3001)
        XCTAssertEqual(VellumContainerPorts.gatewayHTTP, 7830)
        XCTAssertEqual(VellumContainerPorts.cesHTTP, 8090)
    }

    // MARK: - Environment

    func testAssistantEnvRequiredKeys() {
        let env = VellumContainerEnv.assistant(instanceName: "test", signingKey: nil, cesServiceToken: nil)
        XCTAssertEqual(env["IS_CONTAINERIZED"], "true")
        XCTAssertEqual(env["VELLUM_ASSISTANT_NAME"], "test")
        XCTAssertEqual(env["VELLUM_CLOUD"], "apple-container")
        XCTAssertEqual(env["RUNTIME_HTTP_HOST"], "0.0.0.0")
        XCTAssertEqual(env["VELLUM_WORKSPACE_DIR"], "/workspace")
        XCTAssertNotNil(env["CES_CREDENTIAL_URL"])
        XCTAssertNotNil(env["GATEWAY_INTERNAL_URL"])
    }

    func testAssistantEnvOptionalKeys() {
        let env = VellumContainerEnv.assistant(instanceName: "x", signingKey: "key123", cesServiceToken: "tok456")
        XCTAssertEqual(env["ACTOR_TOKEN_SIGNING_KEY"], "key123")
        XCTAssertEqual(env["CES_SERVICE_TOKEN"], "tok456")
    }

    func testAssistantEnvOmitsNilOptionals() {
        let env = VellumContainerEnv.assistant(instanceName: "x", signingKey: nil, cesServiceToken: nil)
        XCTAssertNil(env["ACTOR_TOKEN_SIGNING_KEY"])
        XCTAssertNil(env["CES_SERVICE_TOKEN"])
    }

    func testGatewayEnvRequiredKeys() {
        let env = VellumContainerEnv.gateway(signingKey: nil, bootstrapSecret: nil, cesServiceToken: nil)
        XCTAssertEqual(env["GATEWAY_PORT"], "7830")
        XCTAssertEqual(env["ASSISTANT_HOST"], "localhost")
        XCTAssertEqual(env["RUNTIME_HTTP_PORT"], "3001")
        XCTAssertEqual(env["RUNTIME_PROXY_ENABLED"], "true")
        XCTAssertNotNil(env["CES_CREDENTIAL_URL"])
    }

    func testGatewayEnvOptionalKeys() {
        let env = VellumContainerEnv.gateway(signingKey: "sk", bootstrapSecret: "bs", cesServiceToken: "ct")
        XCTAssertEqual(env["ACTOR_TOKEN_SIGNING_KEY"], "sk")
        XCTAssertEqual(env["GUARDIAN_BOOTSTRAP_SECRET"], "bs")
        XCTAssertEqual(env["CES_SERVICE_TOKEN"], "ct")
    }

    func testCredentialExecutorEnvRequiredKeys() {
        let env = VellumContainerEnv.credentialExecutor(cesServiceToken: nil)
        XCTAssertEqual(env["CES_MODE"], "managed")
        XCTAssertEqual(env["CES_BOOTSTRAP_SOCKET_DIR"], "/run/ces-bootstrap")
        XCTAssertEqual(env["CREDENTIAL_SECURITY_DIR"], "/ces-security")
    }

    func testCredentialExecutorEnvOptionalToken() {
        let env = VellumContainerEnv.credentialExecutor(cesServiceToken: "mytoken")
        XCTAssertEqual(env["CES_SERVICE_TOKEN"], "mytoken")
    }
}
