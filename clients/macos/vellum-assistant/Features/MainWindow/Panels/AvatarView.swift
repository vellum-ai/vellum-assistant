import SwiftUI
import SceneKit

/// 3D voxel dino avatar that the user can rotate by dragging.
/// Seeded from a string so the same name always produces the same dino.
struct DinoSceneView: NSViewRepresentable {
    let seed: String
    var palette: DinoPalette = .violet
    var outfit: DinoOutfit = .none

    final class Coordinator {
        var currentSeed: String = ""
        var currentPalette: DinoPalette = .violet
        var currentOutfit: DinoOutfit = .none
    }

    func makeCoordinator() -> Coordinator { Coordinator() }

    func makeNSView(context: Context) -> SCNView {
        let scnView = PointerSCNView()
        scnView.backgroundColor = .clear
        scnView.allowsCameraControl = true
        scnView.antialiasingMode = .multisampling4X
        scnView.scene = DinoVoxelGenerator.buildScene(seed: seed, palette: palette, outfit: outfit)
        context.coordinator.currentSeed = seed
        context.coordinator.currentPalette = palette
        context.coordinator.currentOutfit = outfit
        return scnView
    }

    func updateNSView(_ nsView: SCNView, context: Context) {
        let coord = context.coordinator
        guard coord.currentSeed != seed || coord.currentPalette != palette || coord.currentOutfit != outfit else { return }
        coord.currentSeed = seed
        coord.currentPalette = palette
        coord.currentOutfit = outfit
        nsView.scene = DinoVoxelGenerator.buildScene(seed: seed, palette: palette, outfit: outfit)
    }
}

/// 3D voxel dino face only — head cropped from the full model.
struct DinoFaceView: NSViewRepresentable {
    let seed: String
    var palette: DinoPalette = .violet
    var outfit: DinoOutfit = .none

    final class Coordinator {
        var currentSeed: String = ""
        var currentPalette: DinoPalette = .violet
        var currentOutfit: DinoOutfit = .none
    }

    func makeCoordinator() -> Coordinator { Coordinator() }

    func makeNSView(context: Context) -> SCNView {
        let scnView = SCNView()
        scnView.backgroundColor = .clear
        scnView.allowsCameraControl = true
        scnView.antialiasingMode = .multisampling4X
        scnView.scene = DinoVoxelGenerator.buildFaceScene(seed: seed, palette: palette, outfit: outfit)
        context.coordinator.currentSeed = seed
        context.coordinator.currentPalette = palette
        context.coordinator.currentOutfit = outfit
        return scnView
    }

    func updateNSView(_ nsView: SCNView, context: Context) {
        let coord = context.coordinator
        guard coord.currentSeed != seed || coord.currentPalette != palette || coord.currentOutfit != outfit else { return }
        coord.currentSeed = seed
        coord.currentPalette = palette
        coord.currentOutfit = outfit
        nsView.scene = DinoVoxelGenerator.buildFaceScene(seed: seed, palette: palette, outfit: outfit)
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
