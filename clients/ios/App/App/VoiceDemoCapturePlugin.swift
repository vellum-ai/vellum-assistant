#if DEBUG
import AVFAudio
import Capacitor
import UIKit

enum VoiceDemoCaptureMode {
    static var isEnabled: Bool {
        let process = ProcessInfo.processInfo
        return process.arguments.contains("-VoiceDemoCapture")
            || process.environment["VOICE_DEMO_CAPTURE"] == "1"
    }
}

@objc(VoiceDemoCapturePlugin)
public final class VoiceDemoCapturePlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "VoiceDemoCapturePlugin"
    public let jsName = "VoiceDemoCapture"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "getAudioRoute", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "exportCapture", returnType: CAPPluginReturnPromise),
    ]

    private var routeObserver: NSObjectProtocol?

    public override func load() {
        routeObserver = NotificationCenter.default.addObserver(
            forName: AVAudioSession.routeChangeNotification,
            object: nil,
            queue: .main
        ) { [weak self] _ in
            guard let self else { return }
            self.notifyListeners("audioRouteChanged", data: self.audioRoutePayload())
        }
    }

    deinit {
        if let routeObserver {
            NotificationCenter.default.removeObserver(routeObserver)
        }
    }

    @objc public func getAudioRoute(_ call: CAPPluginCall) {
        call.resolve(audioRoutePayload())
    }

    @objc public func exportCapture(_ call: CAPPluginCall) {
        guard let filename = call.getString("filename"), !filename.isEmpty else {
            call.reject("Missing required option: filename")
            return
        }
        guard let dataBase64 = call.getString("dataBase64"),
              let archive = Data(base64Encoded: dataBase64)
        else {
            call.reject("Voice demo archive is not valid base64")
            return
        }

        let safeFilename = URL(fileURLWithPath: filename).lastPathComponent
        guard safeFilename.hasSuffix(".zip") else {
            call.reject("Voice demo archive must use a .zip filename")
            return
        }

        DispatchQueue.global(qos: .utility).async { [weak self] in
            guard let self else { return }
            do {
                let caches = try FileManager.default.url(
                    for: .cachesDirectory,
                    in: .userDomainMask,
                    appropriateFor: nil,
                    create: true
                )
                let directory = caches.appendingPathComponent(
                    "VoiceDemoCaptures",
                    isDirectory: true
                )
                try FileManager.default.createDirectory(
                    at: directory,
                    withIntermediateDirectories: true
                )
                let archiveURL = directory.appendingPathComponent(safeFilename)
                try archive.write(to: archiveURL, options: .atomic)
                NSLog("[voice-demo-capture] bundle URL: %@", archiveURL.path)

                DispatchQueue.main.async {
                    guard let viewController = self.bridge?.viewController else {
                        call.reject("Voice demo share sheet has no presenting view controller")
                        return
                    }
                    let activity = UIActivityViewController(
                        activityItems: [archiveURL],
                        applicationActivities: nil
                    )
                    if let popover = activity.popoverPresentationController {
                        popover.sourceView = viewController.view
                        popover.sourceRect = CGRect(
                            x: viewController.view.bounds.midX,
                            y: viewController.view.bounds.midY,
                            width: 1,
                            height: 1
                        )
                        popover.permittedArrowDirections = []
                    }
                    viewController.present(activity, animated: true) {
                        call.resolve(["url": archiveURL.absoluteString])
                    }
                }
            } catch {
                call.reject("Failed to write voice demo archive: \(error.localizedDescription)")
            }
        }
    }

    private func audioRoutePayload() -> JSObject {
        let session = AVAudioSession.sharedInstance()
        return [
            "inputs": session.currentRoute.inputs.map(Self.portPayload),
            "outputs": session.currentRoute.outputs.map(Self.portPayload),
            "sampleRate": session.sampleRate,
            "ioBufferDuration": session.ioBufferDuration,
        ]
    }

    private static func portPayload(_ port: AVAudioSessionPortDescription) -> JSObject {
        return [
            "name": port.portName,
            "type": port.portType.rawValue,
            "uid": port.uid,
            "channelCount": port.channels?.count ?? 0,
        ]
    }
}
#endif
