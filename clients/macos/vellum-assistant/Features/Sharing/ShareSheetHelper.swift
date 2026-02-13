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
        if isPresented {
            DispatchQueue.main.async {
                context.coordinator.showPicker(nsView)
                self.isPresented = false
            }
        }
    }

    func makeCoordinator() -> Coordinator {
        Coordinator(items: items)
    }

    class Coordinator: NSObject, NSSharingServicePickerDelegate {
        var items: [Any]

        init(items: [Any]) {
            self.items = items
        }

        @objc func showPicker(_ sender: NSView) {
            let picker = NSSharingServicePicker(items: items)
            picker.delegate = self
            picker.show(relativeTo: sender.bounds, of: sender, preferredEdge: .minY)
        }
    }
}
