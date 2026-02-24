import Foundation
import os

/// Errors from the Porcupine C library binding.
enum PorcupineBindingError: Error, CustomStringConvertible {
    case loadFailed(String)
    case symbolNotFound(String)
    case outOfMemory(String, [String])
    case ioError(String, [String])
    case invalidArgument(String, [String])
    case stopIteration(String, [String])
    case keyError(String, [String])
    case invalidState(String, [String])
    case runtimeError(String, [String])
    case activationError(String, [String])
    case activationLimitReached(String, [String])
    case activationThrottled(String, [String])
    case activationRefused(String, [String])
    case unknownError(Int32, String, [String])

    var description: String {
        switch self {
        case .loadFailed(let msg):
            return "PorcupineBinding load failed: \(msg)"
        case .symbolNotFound(let sym):
            return "PorcupineBinding symbol not found: \(sym)"
        case .outOfMemory(let msg, let stack):
            return "Porcupine out of memory: \(msg)\(formatStack(stack))"
        case .ioError(let msg, let stack):
            return "Porcupine IO error: \(msg)\(formatStack(stack))"
        case .invalidArgument(let msg, let stack):
            return "Porcupine invalid argument: \(msg)\(formatStack(stack))"
        case .stopIteration(let msg, let stack):
            return "Porcupine stop iteration: \(msg)\(formatStack(stack))"
        case .keyError(let msg, let stack):
            return "Porcupine key error: \(msg)\(formatStack(stack))"
        case .invalidState(let msg, let stack):
            return "Porcupine invalid state: \(msg)\(formatStack(stack))"
        case .runtimeError(let msg, let stack):
            return "Porcupine runtime error: \(msg)\(formatStack(stack))"
        case .activationError(let msg, let stack):
            return "Porcupine activation error: \(msg)\(formatStack(stack))"
        case .activationLimitReached(let msg, let stack):
            return "Porcupine activation limit reached: \(msg)\(formatStack(stack))"
        case .activationThrottled(let msg, let stack):
            return "Porcupine activation throttled: \(msg)\(formatStack(stack))"
        case .activationRefused(let msg, let stack):
            return "Porcupine activation refused: \(msg)\(formatStack(stack))"
        case .unknownError(let code, let msg, let stack):
            return "Porcupine unknown error (\(code)): \(msg)\(formatStack(stack))"
        }
    }

    private func formatStack(_ stack: [String]) -> String {
        guard !stack.isEmpty else { return "" }
        return " | Error stack: " + stack.joined(separator: " -> ")
    }
}

// MARK: - Function pointer typedefs

private typealias PvPorcupineInitFunc = @convention(c) (
    UnsafePointer<CChar>?,   // access_key
    UnsafePointer<CChar>?,   // model_path
    Int32,                    // num_keywords
    UnsafeMutablePointer<UnsafePointer<CChar>?>?,  // keyword_paths
    UnsafePointer<Float>?,   // sensitivities
    UnsafeMutablePointer<OpaquePointer?>?           // object (out)
) -> Int32

private typealias PvPorcupineDeleteFunc = @convention(c) (
    OpaquePointer?           // object
) -> Void

private typealias PvPorcupineProcessFunc = @convention(c) (
    OpaquePointer?,          // object
    UnsafePointer<Int16>?,   // pcm
    UnsafeMutablePointer<Int32>?  // keyword_index (out)
) -> Int32

private typealias PvPorcupineFrameLengthFunc = @convention(c) () -> Int32

private typealias PvSampleRateFunc = @convention(c) () -> Int32

private typealias PvPorcupineVersionFunc = @convention(c) () -> UnsafePointer<CChar>?

private typealias PvGetErrorStackFunc = @convention(c) (
    UnsafeMutablePointer<UnsafeMutablePointer<UnsafeMutablePointer<CChar>?>?>?,  // message_stack (out)
    UnsafeMutablePointer<Int32>?  // message_stack_depth (out)
) -> Int32

private typealias PvFreeErrorStackFunc = @convention(c) (
    UnsafeMutablePointer<UnsafeMutablePointer<CChar>?>?  // message_stack
) -> Void

private typealias PvStatusToStringFunc = @convention(c) (
    Int32  // status
) -> UnsafePointer<CChar>?

// MARK: - PorcupineBinding

/// Swift wrapper around Porcupine's C API, loaded via `dlopen`/`dlsym`.
///
/// Loads `libpv_porcupine.dylib` from `Bundle.main.privateFrameworksPath` and
/// resolves all function pointers at init time. Exposes a Swift-friendly
/// interface for wake word detection.
final class PorcupineBinding {

    private static let logger = Logger(
        subsystem: "com.vellum.vellum-assistant",
        category: "PorcupineBinding"
    )

    // MARK: - Library handle & function pointers

    private let libraryHandle: UnsafeMutableRawPointer
    private let pvPorcupineInit: PvPorcupineInitFunc
    private let pvPorcupineDelete: PvPorcupineDeleteFunc
    private let pvPorcupineProcess: PvPorcupineProcessFunc
    private let pvPorcupineFrameLength: PvPorcupineFrameLengthFunc
    private let pvSampleRate: PvSampleRateFunc
    private let pvPorcupineVersion: PvPorcupineVersionFunc
    private let pvGetErrorStack: PvGetErrorStackFunc
    private let pvFreeErrorStack: PvFreeErrorStackFunc
    private let pvStatusToString: PvStatusToStringFunc

    /// Opaque handle returned by `pv_porcupine_init`.
    private var handle: OpaquePointer?

    // MARK: - Init

    /// Load `libpv_porcupine.dylib` from the given path and resolve all C symbols.
    ///
    /// - Parameter dylibPath: Absolute path to `libpv_porcupine.dylib`.
    /// - Throws: `PorcupineBindingError.loadFailed` if `dlopen` fails,
    ///           `PorcupineBindingError.symbolNotFound` if any symbol is missing.
    init(dylibPath: String) throws {
        guard let lib = dlopen(dylibPath, RTLD_NOW) else {
            let err = String(cString: dlerror())
            throw PorcupineBindingError.loadFailed("dlopen failed for \(dylibPath): \(err)")
        }
        self.libraryHandle = lib

        func resolve<T>(_ name: String) throws -> T {
            guard let sym = dlsym(lib, name) else {
                dlclose(lib)
                throw PorcupineBindingError.symbolNotFound(name)
            }
            return unsafeBitCast(sym, to: T.self)
        }

        self.pvPorcupineInit = try resolve("pv_porcupine_init")
        self.pvPorcupineDelete = try resolve("pv_porcupine_delete")
        self.pvPorcupineProcess = try resolve("pv_porcupine_process")
        self.pvPorcupineFrameLength = try resolve("pv_porcupine_frame_length")
        self.pvSampleRate = try resolve("pv_sample_rate")
        self.pvPorcupineVersion = try resolve("pv_porcupine_version")
        self.pvGetErrorStack = try resolve("pv_get_error_stack")
        self.pvFreeErrorStack = try resolve("pv_free_error_stack")
        self.pvStatusToString = try resolve("pv_status_to_string")

        // Smoke test: verify the dylib loaded correctly by reading its version
        let ver = version
        Self.logger.info("Loaded Porcupine dylib version \(ver) from \(dylibPath)")
    }

    deinit {
        delete()
        dlclose(libraryHandle)
    }

    // MARK: - Public interface

    /// Initialize the Porcupine engine with the given parameters.
    ///
    /// - Parameters:
    ///   - accessKey: Picovoice access key.
    ///   - modelPath: Absolute path to the model `.pv` file.
    ///   - keywordPaths: Absolute paths to keyword `.ppn` files.
    ///   - sensitivities: Detection sensitivities in [0, 1], one per keyword.
    /// - Throws: `PorcupineBindingError` on failure.
    func initialize(
        accessKey: String,
        modelPath: String,
        keywordPaths: [String],
        sensitivities: [Float]
    ) throws {
        guard keywordPaths.count == sensitivities.count else {
            throw PorcupineBindingError.invalidArgument(
                "Number of keyword paths (\(keywordPaths.count)) does not match number of sensitivities (\(sensitivities.count))",
                []
            )
        }

        // Build a C-compatible array of keyword path strings using strdup
        // (same pattern as the iOS binding)
        var cKeywordPaths = keywordPaths.map { UnsafePointer<CChar>(strdup($0)) }
        defer { cKeywordPaths.forEach { free(UnsafeMutablePointer(mutating: $0)) } }

        var porcupineHandle: OpaquePointer?
        let status = pvPorcupineInit(
            accessKey,
            modelPath,
            Int32(keywordPaths.count),
            &cKeywordPaths,
            sensitivities,
            &porcupineHandle
        )

        if status != 0 {
            let messageStack = getErrorStack()
            throw mapStatus(status, message: "pv_porcupine_init failed", stack: messageStack)
        }

        // Release any previously-initialized engine before overwriting the handle
        delete()

        self.handle = porcupineHandle
        Self.logger.info("Porcupine engine initialized with \(keywordPaths.count) keyword(s)")
    }

    /// Process one frame of 16-bit PCM audio.
    ///
    /// - Parameter pcm: Audio samples; length must equal `frameLength`.
    /// - Returns: Index of detected keyword (0-based), or -1 if none detected.
    /// - Throws: `PorcupineBindingError` on failure.
    func process(pcm: [Int16]) throws -> Int32 {
        guard let handle = self.handle else {
            throw PorcupineBindingError.invalidState("Porcupine not initialized", [])
        }

        guard pcm.count == Int(frameLength) else {
            throw PorcupineBindingError.invalidArgument(
                "PCM frame must contain exactly \(frameLength) samples, got \(pcm.count)",
                []
            )
        }

        var keywordIndex: Int32 = -1
        let status = pvPorcupineProcess(handle, pcm, &keywordIndex)

        if status != 0 {
            let messageStack = getErrorStack()
            throw mapStatus(status, message: "pv_porcupine_process failed", stack: messageStack)
        }

        return keywordIndex
    }

    /// Release the Porcupine engine. Safe to call multiple times.
    func delete() {
        if let handle = self.handle {
            pvPorcupineDelete(handle)
            self.handle = nil
            Self.logger.info("Porcupine engine deleted")
        }
    }

    // MARK: - Computed properties

    /// Number of audio samples per frame expected by `process(pcm:)`.
    var frameLength: Int32 {
        pvPorcupineFrameLength()
    }

    /// Audio sample rate expected by the engine (typically 16000).
    var sampleRate: Int32 {
        pvSampleRate()
    }

    /// Porcupine library version string.
    var version: String {
        guard let cStr = pvPorcupineVersion() else { return "unknown" }
        return String(cString: cStr)
    }

    // MARK: - Error handling

    /// Retrieve the error message stack from Porcupine after a failed call.
    private func getErrorStack() -> [String] {
        var messageStackRef: UnsafeMutablePointer<UnsafeMutablePointer<CChar>?>?
        var messageStackDepth: Int32 = 0
        let status = pvGetErrorStack(&messageStackRef, &messageStackDepth)

        guard status == 0, let stackPtr = messageStackRef else {
            return []
        }

        var messages: [String] = []
        for i in 0..<Int(messageStackDepth) {
            if let msgPtr = stackPtr.advanced(by: i).pointee {
                messages.append(String(cString: msgPtr))
            }
        }

        pvFreeErrorStack(messageStackRef)
        return messages
    }

    /// Map a `pv_status_t` integer to a `PorcupineBindingError`.
    private func mapStatus(_ status: Int32, message: String, stack: [String]) -> PorcupineBindingError {
        switch status {
        case 1:  return .outOfMemory(message, stack)
        case 2:  return .ioError(message, stack)
        case 3:  return .invalidArgument(message, stack)
        case 4:  return .stopIteration(message, stack)
        case 5:  return .keyError(message, stack)
        case 6:  return .invalidState(message, stack)
        case 7:  return .runtimeError(message, stack)
        case 8:  return .activationError(message, stack)
        case 9:  return .activationLimitReached(message, stack)
        case 10: return .activationThrottled(message, stack)
        case 11: return .activationRefused(message, stack)
        default:
            var statusName = "unknown"
            if let cStr = pvStatusToString(status) {
                statusName = String(cString: cStr)
            }
            return .unknownError(status, "\(statusName): \(message)", stack)
        }
    }
}
