import Foundation

// AppleContainersRuntimeBridge — runtime registration bridge.
//
// `VellumAssistantLib` defines `AppleContainersPodRuntimeRegistry` but cannot
// import this module at compile time (the main package targets macOS 14;
// this module requires macOS 15+).
//
// The bridge provides a C-callable entry point
// `vellum_register_pod_runtime_factory` that `AppleContainersRuntimeLoader`
// calls via `dlsym` immediately after `dlopen`.  It posts a
// `com.vellum.AppleContainersRuntimeDidLoad` notification so
// `AppleContainersLauncher` can capture the factory provider.

// MARK: - C entry point

/// Called by `AppleContainersRuntimeLoader` via `dlsym` after `dlopen`.
///
/// Posts a `com.vellum.AppleContainersRuntimeDidLoad` notification carrying
/// an `AppleContainersPodRuntimeFactoryProvider` as the `object`.
///
/// Exported with C linkage to survive Swift name mangling.
@_silgen_name("vellum_register_pod_runtime_factory")
public func vellumRegisterPodRuntimeFactory() {
    let provider = AppleContainersPodRuntimeFactoryProvider()

    // Post synchronously so that makePodRuntimeHandle() in
    // AppleContainersLauncher can read factoryProvider immediately after
    // vellum_register_pod_runtime_factory() returns.  An async dispatch would
    // let makePodRuntimeHandle() run before the notification fires, leaving
    // factoryProvider nil on the first launch.
    NotificationCenter.default.post(
        name: Notification.Name("com.vellum.AppleContainersRuntimeDidLoad"),
        object: provider,
        userInfo: nil
    )
}

// MARK: - Factory provider

/// An `NSObject` that creates `AppleContainersPodRuntimeAdapter` instances on
/// demand in response to `com.vellum.AppleContainersRequestRuntime` notifications.
///
/// Passed as the `object` on `com.vellum.AppleContainersRuntimeDidLoad` so
/// `AppleContainersLauncher` can capture it without importing this module.
public final class AppleContainersPodRuntimeFactoryProvider: NSObject {

    private var requestObserver: NSObjectProtocol?

    override public init() {
        super.init()
        // Observe runtime-creation requests from VellumAssistantLib.
        requestObserver = NotificationCenter.default.addObserver(
            forName: Notification.Name("com.vellum.AppleContainersRequestRuntime"),
            object: self,
            queue: nil
        ) { [weak self] note in
            guard let self else { return }
            self.handleRuntimeRequest(note)
        }
    }

    deinit {
        if let obs = requestObserver {
            NotificationCenter.default.removeObserver(obs)
        }
    }

    private func handleRuntimeRequest(_ note: Notification) {
        guard let info = note.userInfo,
              let instanceName = info["instanceName"] as? String,
              let version = info["version"] as? String,
              let hostDataDirectory = info["hostDataDirectory"] as? URL,
              let hostCesBootstrapDirectory = info["hostCesBootstrapDirectory"] as? URL,
              let gatewayHostPort = info["gatewayHostPort"] as? Int else {
            return
        }

        let anthropicApiKey = info["anthropicApiKey"] as? String
        let vellumPlatformURL = info["vellumPlatformURL"] as? String

        let adapter = makeRuntime(
            instanceName: instanceName,
            version: version,
            hostDataDirectory: hostDataDirectory,
            hostCesBootstrapDirectory: hostCesBootstrapDirectory,
            anthropicApiKey: anthropicApiKey,
            vellumPlatformURL: vellumPlatformURL,
            gatewayHostPort: gatewayHostPort
        )

        NotificationCenter.default.post(
            name: Notification.Name("com.vellum.AppleContainersMakeRuntime"),
            object: self,
            userInfo: ["adapter": adapter]
        )
    }

    /// Creates a new pod runtime adapter for the given stack parameters.
    @objc
    public func makeRuntime(
        instanceName: String,
        version: String,
        hostDataDirectory: URL,
        hostCesBootstrapDirectory: URL,
        anthropicApiKey: String?,
        vellumPlatformURL: String?,
        gatewayHostPort: Int
    ) -> NSObject {
        let definition = AppleContainerStackDefinition(
            instanceName: instanceName,
            version: version,
            hostDataDirectory: hostDataDirectory,
            hostCesBootstrapDirectory: hostCesBootstrapDirectory,
            anthropicApiKey: anthropicApiKey,
            vellumPlatformURL: vellumPlatformURL,
            gatewayHostPort: gatewayHostPort
        )
        let kernelStore = KataKernelStore()
        return AppleContainersPodRuntimeAdapter(
            runtime: AppleContainersPodRuntime(
                definition: definition,
                kernelStore: kernelStore
            )
        )
    }
}

// MARK: - Runtime adapter

/// Wraps `AppleContainersPodRuntime` as an `NSObject` so it can be passed
/// across the dlopen module boundary.
///
/// `VellumAssistantLib` calls `hatchAsync:` and `retireAsync:` via ObjC
/// messaging, keeping the main package build target at macOS 14.
public final class AppleContainersPodRuntimeAdapter: NSObject {
    private let runtime: AppleContainersPodRuntime

    public init(runtime: AppleContainersPodRuntime) {
        self.runtime = runtime
    }

    /// Starts the pod.  Calls `completionHandler(nil)` on success or
    /// `completionHandler(error)` on failure.
    @objc(hatchAsync:)
    public func hatchAsync(completionHandler: @escaping (Error?) -> Void) {
        Task {
            do {
                try await self.runtime.hatch()
                completionHandler(nil)
            } catch {
                completionHandler(error)
            }
        }
    }

    /// Stops the pod.  Calls `completionHandler(nil)` on success or
    /// `completionHandler(error)` on failure.
    @objc(retireAsync:)
    public func retireAsync(completionHandler: @escaping (Error?) -> Void) {
        Task {
            do {
                try await self.runtime.retire()
                completionHandler(nil)
            } catch {
                completionHandler(error)
            }
        }
    }
}
