import AppKit
import SwiftUI

/// An NSView wrapper that presents an NSSharingServicePicker anchored to itself.
/// Usage: set `isPresented` to `true` to trigger the share sheet with `items`.
struct ShareSheetButton: NSViewRepresentable {
    let items: [Any]
    @Binding var isPresented: Bool

    func makeNSView(context: Context) -> NSButton {
        let button = NSButton(frame: .zero)
        button.bezelStyle = .inline
        button.isBordered = false
        button.title = ""
        button.image = NSImage(systemSymbolName: "square.and.arrow.up", accessibilityDescription: "Share")
        button.target = context.coordinator
        button.action = #selector(Coordinator.showPicker(_:))
        // Make the button invisible — SwiftUI overlay handles appearance
        button.alphaValue = 0.01
        return button
    }

    func updateNSView(_ nsView: NSButton, context: Context) {
        context.coordinator.items = items
        if isPresented && !context.coordinator.isPickerVisible {
            // Delay presentation until the next run-loop iteration so the
            // NSButton is fully attached to its window. Showing a picker on
            // a view without a window crashes NSSharingServicePicker.
            DispatchQueue.main.async {
                guard nsView.window != nil else {
                    self.isPresented = false
                    return
                }
                context.coordinator.onDismiss = {
                    self.isPresented = false
                }
                context.coordinator.showPicker(nsView)
            }
        }
    }

    func makeCoordinator() -> Coordinator {
        Coordinator(items: items)
    }

    class Coordinator: NSObject, NSSharingServicePickerDelegate {
        var items: [Any]
        var isPickerVisible = false
        var onDismiss: (() -> Void)?

        init(items: [Any]) {
            self.items = items
        }

        @objc func showPicker(_ sender: NSView) {
            let picker = NSSharingServicePicker(items: items)
            picker.delegate = self
            isPickerVisible = true
            picker.show(relativeTo: sender.bounds, of: sender, preferredEdge: .minY)
        }

        func sharingServicePicker(
            _ sharingServicePicker: NSSharingServicePicker,
            sharingServicesForItems items: [Any],
            proposedSharingServices proposedServices: [NSSharingService]
        ) -> [NSSharingService] {
            let slackService = NSSharingService(
                title: "Slack",
                image: NSWorkspace.shared.icon(forFile: "/Applications/Slack.app"),
                alternateImage: nil
            ) { [weak self] in
                guard let self else { return }
                self.handleSlackShare(items: items)
            }
            return [slackService] + proposedServices
        }

        func sharingServicePicker(_ sharingServicePicker: NSSharingServicePicker, didChoose service: NSSharingService?) {
            // Called when the user picks a service or dismisses the picker (service == nil).
            isPickerVisible = false
            onDismiss?()
            onDismiss = nil
        }

        private func handleSlackShare(items: [Any]) {
            // Find the first file URL in the shared items
            guard let fileURL = items.compactMap({ $0 as? URL }).first(where: { $0.isFileURL }) else {
                return
            }

            let downloadsURL = FileManager.default.urls(for: .downloadsDirectory, in: .userDomainMask).first!
            let destinationURL = downloadsURL.appendingPathComponent(fileURL.lastPathComponent)

            // Copy to Downloads if not already there
            if fileURL.standardizedFileURL != destinationURL.standardizedFileURL {
                try? FileManager.default.removeItem(at: destinationURL)
                try? FileManager.default.copyItem(at: fileURL, to: destinationURL)
            }

            // Open Slack
            if let slackURL = URL(string: "slack://") {
                NSWorkspace.shared.open(slackURL)
            }

            // Reveal the file in Finder so the user can drag it into Slack
            NSWorkspace.shared.activateFileViewerSelecting([destinationURL])
        }
    }
}
