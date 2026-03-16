import Foundation

// AppleContainerStackDefinition — mirrors the three-service topology defined
// in cli/src/lib/docker.ts for the Apple Containers pod runtime.
//
// The Docker topology runs three services sharing a network and two named
// volumes:
//
//   assistant          ← daemon HTTP server on :3001
//   gateway            ← channel ingress on :7830
//   credential-executor (CES) ← authenticated command runner
//
// In the Apple Containers path those three services run inside a single
// LinuxPod VM (one Virtualization framework VM), communicating over the pod's
// internal network rather than Docker bridge networking.  Two directories are
// shared across all three services via virtio-fs mounts:
//
//   /data                — persistent assistant workspace
//   /run/ces-bootstrap   — CES unix-socket bootstrap directory

// MARK: - Image references

/// The DockerHub organisation that hosts Vellum service images.
public let vellumDockerHubOrg = "vellumai"

/// Strongly-typed names for the three services in the stack.
public enum VellumServiceName: String, CaseIterable, Sendable {
    case assistant          = "assistant"
    case gateway            = "gateway"
    case credentialExecutor = "credential-executor"
}

/// Fully-qualified OCI image reference for a Vellum service.
public struct VellumImageReference: Equatable, Sendable {
    /// The OCI registry/repository path (without the tag).
    public let repository: String
    /// The image tag, e.g. `"v1.2.3"` or `"latest"`.
    public let tag: String

    /// The full reference string: `"<repository>:<tag>"`.
    public var fullReference: String { "\(repository):\(tag)" }

    public init(repository: String, tag: String) {
        self.repository = repository
        self.tag = tag
    }

    /// Returns the image reference with a different tag (e.g. to pin to a
    /// specific version).
    public func withTag(_ newTag: String) -> VellumImageReference {
        VellumImageReference(repository: repository, tag: newTag)
    }
}

// MARK: - Mount paths

/// Well-known in-VM directory paths shared across pod services.
public enum VellumPodMount {
    /// Persistent data directory (`/data`). Mapped to a per-instance host
    /// directory in `AppleContainerStackDefinition`.
    public static let dataDirectory = "/data"

    /// CES unix-socket bootstrap directory (`/run/ces-bootstrap`). The
    /// credential-executor creates a socket here; the assistant daemon
    /// connects to it.
    public static let cesBootstrapDirectory = "/run/ces-bootstrap"
}

// MARK: - Service ports

/// Well-known in-VM port numbers for each service (matches Dockerfiles).
public enum VellumServicePort {
    /// Assistant daemon HTTP server port.
    public static let assistant = 3001
    /// Gateway HTTP port.
    public static let gateway = 7830
}

// MARK: - Environment variable keys

/// Environment variable names injected into service processes.
public enum VellumServiceEnvKey {
    // --- assistant ---
    public static let assistantName   = "VELLUM_ASSISTANT_NAME"
    public static let runtimeHttpHost = "RUNTIME_HTTP_HOST"
    public static let anthropicApiKey = "ANTHROPIC" + "_API_KEY"
    public static let vellumPlatformUrl = "VELLUM_PLATFORM_URL"

    // --- gateway ---
    public static let baseDataDir     = "BASE_DATA_DIR"
    public static let gatewayPort     = "GATEWAY_PORT"
    public static let assistantHost   = "ASSISTANT_HOST"
    public static let runtimeHttpPort = "RUNTIME_HTTP_PORT"

    // --- credential-executor ---
    public static let cesMode                = "CES_MODE"
    public static let cesBootstrapSocketDir  = "CES_BOOTSTRAP_SOCKET_DIR"
    public static let cesAssistantDataMount  = "CES_ASSISTANT_DATA_MOUNT"
}

// MARK: - Readiness sentinel

/// Sentinel string written to stdout by the assistant daemon once it has
/// finished starting up and is ready to accept connections.
///
/// `AppleContainersPodRuntime` watches the assistant container's log stream
/// for this string before returning from `hatch()`.
public let assistantReadinessSentinel = "DaemonServer started"

// MARK: - Stack definition

/// Describes the complete topology of the three-service Vellum stack as it
/// runs inside an Apple Containers `LinuxPod`.
///
/// ### Responsibilities
/// - Picks version-tagged image references for each service.
/// - Defines the two shared in-VM mounts (`/data` and `/run/ces-bootstrap`).
/// - Provides the environment variables to inject into each service process.
///
/// ### Usage
/// ```swift
/// let def = AppleContainerStackDefinition(
///     instanceName: "meadow-fox",
///     version: "v1.5.0",
///     hostDataDirectory: URL(fileURLWithPath: "/Users/alice/.vellum/instances/meadow-fox"),
///     hostCesBootstrapDirectory: URL(fileURLWithPath: "/tmp/ces-meadow-fox"),
///     anthropicApiKey: ProcessInfo.processInfo.environment["ANTHROPIC_API_KEY"]
/// )
/// let assistantRef = def.imageReference(for: .assistant) // vellumai/vellum-assistant:v1.5.0
/// ```
public struct AppleContainerStackDefinition: Sendable {

    // MARK: - Properties

    /// The assistant instance name (e.g. `"meadow-fox"`).
    public let instanceName: String

    /// Version tag used for all three service images (e.g. `"v1.5.0"`).
    public let version: String

    /// Host-side directory that will be mounted read-write at
    /// `VellumPodMount.dataDirectory` (`/data`) inside the pod.
    public let hostDataDirectory: URL

    /// Host-side directory that will be mounted read-write at
    /// `VellumPodMount.cesBootstrapDirectory` (`/run/ces-bootstrap`) inside
    /// the pod.
    public let hostCesBootstrapDirectory: URL

    /// Optional Anthropic API key to forward into the assistant process.
    public let anthropicApiKey: String?

    /// Optional Vellum platform URL override.
    public let vellumPlatformURL: String?

    /// The gateway port exposed on the host.  Defaults to `7830`.
    public let gatewayHostPort: Int

    // MARK: - Lifecycle

    public init(
        instanceName: String,
        version: String,
        hostDataDirectory: URL,
        hostCesBootstrapDirectory: URL,
        anthropicApiKey: String? = nil,
        vellumPlatformURL: String? = nil,
        gatewayHostPort: Int = VellumServicePort.gateway
    ) {
        self.instanceName = instanceName
        self.version = version
        self.hostDataDirectory = hostDataDirectory
        self.hostCesBootstrapDirectory = hostCesBootstrapDirectory
        self.anthropicApiKey = anthropicApiKey
        self.vellumPlatformURL = vellumPlatformURL
        self.gatewayHostPort = gatewayHostPort
    }

    // MARK: - Image references

    /// Returns the OCI image reference for a given service at the stack's
    /// version tag.
    public func imageReference(for service: VellumServiceName) -> VellumImageReference {
        let repo: String
        switch service {
        case .assistant:
            repo = "\(vellumDockerHubOrg)/vellum-assistant"
        case .gateway:
            repo = "\(vellumDockerHubOrg)/vellum-gateway"
        case .credentialExecutor:
            repo = "\(vellumDockerHubOrg)/vellum-credential-executor"
        }
        return VellumImageReference(repository: repo, tag: version)
    }

    // MARK: - Environment variables

    /// Returns the environment variables to inject into the assistant process.
    public func assistantEnvironment() -> [String: String] {
        var env: [String: String] = [
            VellumServiceEnvKey.assistantName:   instanceName,
            VellumServiceEnvKey.runtimeHttpHost: "0.0.0.0",
        ]
        if let key = anthropicApiKey {
            env[VellumServiceEnvKey.anthropicApiKey] = key
        }
        if let url = vellumPlatformURL {
            env[VellumServiceEnvKey.vellumPlatformUrl] = url
        }
        return env
    }

    /// Returns the environment variables to inject into the gateway process.
    public func gatewayEnvironment() -> [String: String] {
        [
            VellumServiceEnvKey.baseDataDir:     VellumPodMount.dataDirectory,
            VellumServiceEnvKey.gatewayPort:     String(VellumServicePort.gateway),
            // Inside the pod the services communicate over localhost.
            VellumServiceEnvKey.assistantHost:   "localhost",
            VellumServiceEnvKey.runtimeHttpPort: String(VellumServicePort.assistant),
        ]
    }

    /// Returns the environment variables to inject into the credential-executor
    /// process.
    public func cesEnvironment() -> [String: String] {
        [
            VellumServiceEnvKey.cesMode:               "managed",
            VellumServiceEnvKey.cesBootstrapSocketDir: VellumPodMount.cesBootstrapDirectory,
            VellumServiceEnvKey.cesAssistantDataMount:  VellumPodMount.dataDirectory,
        ]
    }

    // MARK: - Log stream labels

    /// Tagged log-stream prefix for a service (e.g. `"[assistant]"`).
    public func logPrefix(for service: VellumServiceName) -> String {
        "[\(service.rawValue)]"
    }
}
