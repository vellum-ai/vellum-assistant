import Foundation

/// Loads avatar appearance from LOOKS.md, watches for changes, and provides
/// the current DinoPalette for rendering. @Observable so SwiftUI views reactively update.
@MainActor @Observable
final class AvatarAppearanceManager {
    private(set) var palette: DinoPalette = .violet
    private(set) var outfit: DinoOutfit = .none
    private(set) var config: LooksConfig = .default
    private var fileMonitor: DispatchSourceFileSystemObject?

    static let shared = AvatarAppearanceManager()

    private var looksPath: String {
        NSHomeDirectory() + "/.vellum/workspace/LOOKS.md"
    }

    func start() {
        reload()
        watchFile()
    }

    private func reload() {
        guard let content = try? String(contentsOfFile: looksPath, encoding: .utf8) else {
            return
        }
        config = LooksConfig.parse(from: content)
        palette = config.toPalette()
        outfit = config.toOutfit()
    }

    private func watchFile() {
        fileMonitor?.cancel()
        fileMonitor = nil

        let path = looksPath
        let fd = open(path, O_EVTONLY)
        guard fd >= 0 else { return }

        let source = DispatchSource.makeFileSystemObjectSource(
            fileDescriptor: fd,
            eventMask: [.write, .delete, .rename],
            queue: .global(qos: .utility)
        )

        source.setEventHandler { [weak self] in
            Task { @MainActor [weak self] in
                self?.reload()
                // Re-watch in case of delete+recreate
                let flags = source.data
                if flags.contains(.delete) || flags.contains(.rename) {
                    self?.watchFile()
                }
            }
        }

        source.setCancelHandler {
            close(fd)
        }

        fileMonitor = source
        source.resume()
    }
}
