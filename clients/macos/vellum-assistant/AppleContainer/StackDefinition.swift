import Foundation

// MARK: - Service Names

/// The three services that make up a Vellum assistant stack.
enum VellumServiceName: String, CaseIterable, Sendable {
    case assistant = "vellum-assistant"
    case gateway = "vellum-gateway"
    case credentialExecutor = "vellum-credential-executor"
}

// MARK: - Image References

/// An OCI image reference for a Vellum service container.
struct VellumImageReference: Sendable, Equatable {
    let registry: String
    let repository: String
    let tag: String

    var fullReference: String {
        "\(registry)/\(repository):\(tag)"
    }

    /// Default image references for a given service group version, pulled from Docker Hub.
    static func defaults(version: String) -> [VellumServiceName: VellumImageReference] {
        let org = "vellumai"
        return [
            .assistant: VellumImageReference(
                registry: "docker.io",
                repository: "\(org)/vellum-assistant",
                tag: version
            ),
            .gateway: VellumImageReference(
                registry: "docker.io",
                repository: "\(org)/vellum-gateway",
                tag: version
            ),
            .credentialExecutor: VellumImageReference(
                registry: "docker.io",
                repository: "\(org)/vellum-credential-executor",
                tag: version
            ),
        ]
    }
}

// MARK: - Ports

/// Internal ports exposed by each service's container.
enum VellumContainerPorts {
    static let assistantHTTP: UInt16 = 3001
    static let gatewayHTTP: UInt16 = 7830
    static let cesHTTP: UInt16 = 8090
}

// MARK: - Mount Paths

/// Well-known mount paths inside the pod VM shared across services.
enum VellumMountPaths {
    /// Persistent assistant workspace data (rw for assistant + gateway, ro for CES).
    static let workspace = "/workspace"
    /// CES bootstrap unix-socket directory.
    static let cesBootstrap = "/run/ces-bootstrap"
    /// Gateway security directory (gateway-private).
    static let gatewaySecurityDir = "/gateway-security"
    /// CES credential security directory (CES-private).
    static let cesSecurityDir = "/ces-security"
}

// MARK: - Environment Keys

/// Environment variable keys passed to each container.
enum VellumContainerEnv {
    static func assistant(
        instanceName: String,
        signingKey: String?,
        cesServiceToken: String?
    ) -> [String: String] {
        var env: [String: String] = [
            "IS_CONTAINERIZED": "true",
            "VELLUM_ASSISTANT_NAME": instanceName,
            "VELLUM_CLOUD": "apple-container",
            "RUNTIME_HTTP_HOST": "0.0.0.0",
            "VELLUM_WORKSPACE_DIR": VellumMountPaths.workspace,
            "CES_CREDENTIAL_URL": "http://localhost:\(VellumContainerPorts.cesHTTP)",
            "GATEWAY_INTERNAL_URL": "http://localhost:\(VellumContainerPorts.gatewayHTTP)",
        ]
        if let signingKey {
            env["ACTOR_TOKEN_SIGNING_KEY"] = signingKey
        }
        if let cesServiceToken {
            env["CES_SERVICE_TOKEN"] = cesServiceToken
        }
        return env
    }

    static func gateway(
        signingKey: String?,
        bootstrapSecret: String?,
        cesServiceToken: String?
    ) -> [String: String] {
        var env: [String: String] = [
            "VELLUM_WORKSPACE_DIR": VellumMountPaths.workspace,
            "GATEWAY_SECURITY_DIR": VellumMountPaths.gatewaySecurityDir,
            "GATEWAY_PORT": String(VellumContainerPorts.gatewayHTTP),
            "ASSISTANT_HOST": "localhost",
            "RUNTIME_HTTP_PORT": String(VellumContainerPorts.assistantHTTP),
            "RUNTIME_PROXY_ENABLED": "true",
            "CES_CREDENTIAL_URL": "http://localhost:\(VellumContainerPorts.cesHTTP)",
        ]
        if let signingKey {
            env["ACTOR_TOKEN_SIGNING_KEY"] = signingKey
        }
        if let bootstrapSecret {
            env["GUARDIAN_BOOTSTRAP_SECRET"] = bootstrapSecret
        }
        if let cesServiceToken {
            env["CES_SERVICE_TOKEN"] = cesServiceToken
        }
        return env
    }

    static func credentialExecutor(cesServiceToken: String?) -> [String: String] {
        var env: [String: String] = [
            "CES_MODE": "managed",
            "VELLUM_WORKSPACE_DIR": VellumMountPaths.workspace,
            "CES_BOOTSTRAP_SOCKET_DIR": VellumMountPaths.cesBootstrap,
            "CREDENTIAL_SECURITY_DIR": VellumMountPaths.cesSecurityDir,
        ]
        if let cesServiceToken {
            env["CES_SERVICE_TOKEN"] = cesServiceToken
        }
        return env
    }
}

// MARK: - Service Start Order

extension VellumServiceName {
    static let startOrder: [VellumServiceName] = [
        .assistant,
        .gateway,
        .credentialExecutor,
    ]
}
