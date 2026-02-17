import SwiftUI
import SceneKit

/// 3D voxel dino avatar that the user can rotate by dragging.
/// Seeded from a string so the same name always produces the same dino.
struct DinoSceneView: NSViewRepresentable {
    let seed: String

    final class Coordinator {
        var currentSeed: String = ""
    }

    func makeCoordinator() -> Coordinator { Coordinator() }

    func makeNSView(context: Context) -> SCNView {
        let scnView = PointerSCNView()
        scnView.backgroundColor = .clear
        scnView.allowsCameraControl = true
        scnView.antialiasingMode = .multisampling4X
        scnView.scene = DinoVoxelGenerator.buildScene(seed: seed)
        context.coordinator.currentSeed = seed
        return scnView
    }

    func updateNSView(_ nsView: SCNView, context: Context) {
        guard context.coordinator.currentSeed != seed else { return }
        context.coordinator.currentSeed = seed
        nsView.scene = DinoVoxelGenerator.buildScene(seed: seed)
    }
}

/// 3D voxel dino face only — head cropped from the full model.
struct DinoFaceView: NSViewRepresentable {
    let seed: String

    final class Coordinator {
        var currentSeed: String = ""
    }

    func makeCoordinator() -> Coordinator { Coordinator() }

    func makeNSView(context: Context) -> SCNView {
        let scnView = SCNView()
        scnView.backgroundColor = .clear
        scnView.allowsCameraControl = true
        scnView.antialiasingMode = .multisampling4X
        scnView.scene = DinoVoxelGenerator.buildFaceScene(seed: seed)
        context.coordinator.currentSeed = seed
        return scnView
    }

    func updateNSView(_ nsView: SCNView, context: Context) {
        guard context.coordinator.currentSeed != seed else { return }
        context.coordinator.currentSeed = seed
        nsView.scene = DinoVoxelGenerator.buildFaceScene(seed: seed)
    }
}

/// SCNView subclass that shows a pointing-hand cursor on hover.
private final class PointerSCNView: SCNView {
    private var trackingArea: NSTrackingArea?

    override func updateTrackingAreas() {
        super.updateTrackingAreas()
        if let existing = trackingArea {
            removeTrackingArea(existing)
        }
        let area = NSTrackingArea(
            rect: bounds,
            options: [.mouseEnteredAndExited, .activeInActiveApp],
            owner: self,
            userInfo: nil
        )
        addTrackingArea(area)
        trackingArea = area
    }

    override func mouseEntered(with event: NSEvent) {
        NSCursor.pointingHand.push()
    }

    override func mouseExited(with event: NSEvent) {
        NSCursor.pop()
    }
}
