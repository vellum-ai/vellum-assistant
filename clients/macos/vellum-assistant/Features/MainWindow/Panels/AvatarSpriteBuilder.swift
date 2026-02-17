import AppKit
import SceneKit

/// Generates procedural 3D voxel dino characters seeded from a string.
/// Native Swift port of the voxeldino Python package (github.com/avareed-assistant/voxeldino).
/// Each unique seed produces a deterministic dino with randomized clothing/accessories.
enum DinoVoxelGenerator {

    // MARK: - Types

    struct RGB: Hashable {
        let r: UInt8, g: UInt8, b: UInt8

        init(_ r: UInt8, _ g: UInt8, _ b: UInt8) {
            self.r = r; self.g = g; self.b = b
        }

        var nsColor: NSColor {
            NSColor(
                red: CGFloat(r) / 255.0,
                green: CGFloat(g) / 255.0,
                blue: CGFloat(b) / 255.0,
                alpha: 1.0
            )
        }
    }

    struct VoxelPos: Hashable {
        let x: Int, y: Int, z: Int
    }

    // MARK: - Color Palette

    private static let dinoGreen = RGB(76, 175, 80)
    private static let dinoLight = RGB(129, 199, 132)
    private static let dinoBelly = RGB(200, 230, 201)
    private static let dinoDark  = RGB(56, 142, 60)
    private static let eyeWhite  = RGB(255, 255, 255)
    private static let eyeBlack  = RGB(33, 33, 33)
    private static let cheekPink = RGB(255, 160, 170)

    private static let palette: [String: RGB] = [
        "red": RGB(244, 67, 54),
        "blue": RGB(33, 150, 243),
        "yellow": RGB(255, 235, 59),
        "purple": RGB(156, 39, 176),
        "orange": RGB(255, 152, 0),
        "pink": RGB(233, 30, 99),
        "cyan": RGB(0, 188, 212),
        "brown": RGB(121, 85, 72),
        "black": RGB(33, 33, 33),
        "white": RGB(250, 250, 250),
        "gold": RGB(255, 215, 0),
        "silver": RGB(192, 192, 192),
        "glasses_black": RGB(20, 20, 20),
        "glasses_gold": RGB(212, 175, 55),
        "wood": RGB(139, 90, 43),
        "metal": RGB(158, 158, 158),
    ]

    // MARK: - Clothing Definitions

    private struct ClothingDef {
        let positions: [VoxelPos]
        let defaultColor: String
    }

    // Hat options — head top is y=22, crown at y=21
    private static let hatNames = ["none", "top_hat", "crown", "cap", "beanie", "wizard_hat", "cowboy_hat"]

    private static let hatDefs: [String: ClothingDef] = [
        "top_hat": ClothingDef(
            positions: box(x: 4...11, y: 22...22, z: 4...11) +
                       box(x: 5...10, y: 23...27, z: 5...10),
            defaultColor: "black"
        ),
        "crown": ClothingDef(
            positions: box(x: 4...11, y: 22...22, z: 4...11) +
                [4, 7, 11].flatMap { x in [4, 7, 11].map { z in VoxelPos(x: x, y: 23, z: z) } },
            defaultColor: "gold"
        ),
        "cap": ClothingDef(
            positions: box(x: 4...11, y: 22...24, z: 4...11) +
                       box(x: 5...10, y: 22...22, z: 12...14),
            defaultColor: "red"
        ),
        "beanie": ClothingDef(
            positions: box(x: 4...11, y: 22...25, z: 4...11),
            defaultColor: "blue"
        ),
        "wizard_hat": ClothingDef(
            positions: box(x: 4...11, y: 22...22, z: 4...11) +
                       box(x: 5...10, y: 23...25, z: 5...10) +
                       box(x: 6...9, y: 26...28, z: 6...9),
            defaultColor: "purple"
        ),
        "cowboy_hat": ClothingDef(
            positions: box(x: 2...13, y: 22...22, z: 2...13) +
                       box(x: 5...10, y: 23...25, z: 5...10),
            defaultColor: "brown"
        ),
    ]

    // Shirt options — body y=6-12
    private static let shirtNames = ["none", "tshirt", "suit", "hoodie", "tank_top", "sweater"]

    private static let shirtDefs: [String: ClothingDef] = [
        "tshirt": ClothingDef(
            positions: box(x: 4...11, y: 8...12, z: 5...10, excluding: { x, _, z in
                (6...9).contains(x) && z >= 9
            }),
            defaultColor: "blue"
        ),
        "suit": ClothingDef(
            positions: box(x: 4...11, y: 6...12, z: 5...10),
            defaultColor: "black"
        ),
        "hoodie": ClothingDef(
            positions: box(x: 4...11, y: 6...13, z: 4...10),
            defaultColor: "purple"
        ),
        "tank_top": ClothingDef(
            positions: box(x: 5...10, y: 8...12, z: 5...10),
            defaultColor: "white"
        ),
        "sweater": ClothingDef(
            positions: box(x: 4...11, y: 6...12, z: 5...10) +
                [4, 11].flatMap { x in box(x: x...x, y: 9...11, z: 7...9) },
            defaultColor: "orange"
        ),
    ]

    // Accessory options — face z=12, neck y=12-13
    private static let accessoryNames = ["none", "sunglasses", "monocle", "bowtie", "necklace", "scarf", "cape"]

    private static let accessoryDefs: [String: ClothingDef] = [
        "sunglasses": ClothingDef(
            positions: (4...11).map { VoxelPos(x: $0, y: 18, z: 12) } +
                (4...7).map { VoxelPos(x: $0, y: 17, z: 12) } +
                (8...11).map { VoxelPos(x: $0, y: 17, z: 12) },
            defaultColor: "glasses_black"
        ),
        "monocle": ClothingDef(
            positions: box(x: 8...11, y: 17...19, z: 12...12),
            defaultColor: "glasses_gold"
        ),
        "bowtie": ClothingDef(
            positions: [6, 7, 8, 9].map { VoxelPos(x: $0, y: 12, z: 11) },
            defaultColor: "red"
        ),
        "necklace": ClothingDef(
            positions: (5...10).map { VoxelPos(x: $0, y: 12, z: 11) },
            defaultColor: "gold"
        ),
        "scarf": ClothingDef(
            positions: box(x: 4...11, y: 12...13, z: 9...12) +
                (8...12).map { VoxelPos(x: 5, y: $0, z: 12) },
            defaultColor: "cyan"
        ),
        "cape": ClothingDef(
            positions: box(x: 4...11, y: 3...13, z: 3...3) +
                       box(x: 5...10, y: 4...12, z: 4...4),
            defaultColor: "red"
        ),
    ]

    // Held item options — arm at x=3-4 / x=11-12
    private static let heldItemNames = ["none", "sword", "staff", "shield", "balloon"]

    private static let heldItemDefs: [String: ClothingDef] = [
        "sword": ClothingDef(
            positions: (9...18).map { VoxelPos(x: 3, y: $0, z: 8) } +
                [VoxelPos(x: 3, y: 19, z: 8), VoxelPos(x: 3, y: 19, z: 9)],
            defaultColor: "silver"
        ),
        "staff": ClothingDef(
            positions: (7...22).map { VoxelPos(x: 3, y: $0, z: 8) } +
                [VoxelPos(x: 3, y: 23, z: 8), VoxelPos(x: 3, y: 23, z: 9)],
            defaultColor: "wood"
        ),
        "shield": ClothingDef(
            positions: box(x: 12...12, y: 7...12, z: 5...10),
            defaultColor: "metal"
        ),
        "balloon": ClothingDef(
            positions: (14...22).map { VoxelPos(x: 2, y: $0, z: 8) } +
                       box(x: 1...3, y: 23...26, z: 7...9),
            defaultColor: "red"
        ),
    ]

    private static let clothingColorNames = ["red", "blue", "yellow", "purple", "orange", "pink", "cyan", "brown", "black", "white", "gold", "silver"]

    // MARK: - Box Helper

    private static func box(
        x xr: ClosedRange<Int>, y yr: ClosedRange<Int>, z zr: ClosedRange<Int>,
        excluding: ((Int, Int, Int) -> Bool)? = nil
    ) -> [VoxelPos] {
        var positions: [VoxelPos] = []
        for x in xr {
            for y in yr {
                for z in zr {
                    if let exclude = excluding, exclude(x, y, z) { continue }
                    positions.append(VoxelPos(x: x, y: y, z: z))
                }
            }
        }
        return positions
    }

    // MARK: - Base Dino (chibi proportions)

    private static func createBaseDino() -> [VoxelPos: RGB] {
        var voxels: [VoxelPos: RGB] = [:]

        func set(_ x: Int, _ y: Int, _ z: Int, _ color: RGB) {
            voxels[VoxelPos(x: x, y: y, z: z)] = color
        }

        // === HEAD (y=13-22) — big rounded cube ===

        // Bottom jaw (y=13): tapered 8×8
        for x in 4...11 {
            for z in 4...11 {
                let edgeX = (x == 4 || x == 11)
                let edgeZ = (z == 4 || z == 11)
                if edgeX && edgeZ { continue }
                set(x, 13, z, dinoGreen)
            }
        }

        // Main head (y=14-20): 10×10 with rounded corners
        for y in 14...20 {
            for x in 3...12 {
                for z in 3...12 {
                    let edgeX = (x == 3 || x == 12)
                    let edgeZ = (z == 3 || z == 12)
                    if edgeX && edgeZ { continue }
                    set(x, y, z, dinoGreen)
                }
            }
        }

        // Upper head (y=21): tapered 8×8
        for x in 4...11 {
            for z in 4...11 {
                let edgeX = (x == 4 || x == 11)
                let edgeZ = (z == 4 || z == 11)
                if edgeX && edgeZ { continue }
                set(x, 21, z, dinoGreen)
            }
        }

        // Top cap (y=22): small 6×6
        for x in 5...10 { for z in 5...10 { set(x, 22, z, dinoGreen) } }

        // === SNOUT (protruding forward, lighter color) ===
        for x in 5...10 {
            for y in 14...17 {
                for z in 12...14 {
                    set(x, y, z, dinoLight)
                }
            }
        }

        // Nostrils (dark dots on snout front)
        set(6, 16, 14, dinoDark)
        set(9, 16, 14, dinoDark)

        // Mouth line
        for x in 6...9 { set(x, 14, 14, dinoDark) }

        // === EYES (4×3 each, big & expressive) ===

        // Left eye white (x=4-7, y=17-19, z=12)
        for x in 4...7 { for y in 17...19 { set(x, y, 12, eyeWhite) } }
        // Left pupil (2×2, centered-inner)
        set(5, 17, 12, eyeBlack)
        set(6, 17, 12, eyeBlack)
        set(5, 18, 12, eyeBlack)
        set(6, 18, 12, eyeBlack)

        // Right eye white (x=8-11, y=17-19, z=12)
        for x in 8...11 { for y in 17...19 { set(x, y, 12, eyeWhite) } }
        // Right pupil (2×2, centered-inner)
        set(9, 17, 12, eyeBlack)
        set(10, 17, 12, eyeBlack)
        set(9, 18, 12, eyeBlack)
        set(10, 18, 12, eyeBlack)

        // Rosy cheeks (below and outside each eye)
        set(4, 16, 12, cheekPink)
        set(3, 16, 12, cheekPink)
        set(11, 16, 12, cheekPink)
        set(12, 16, 12, cheekPink)

        // === BODY (y=6-12) ===
        for x in 5...10 {
            for y in 6...12 {
                for z in 5...10 {
                    if z >= 9 {
                        set(x, y, z, dinoBelly)
                    } else {
                        set(x, y, z, dinoGreen)
                    }
                }
            }
        }

        // === ARMS (tiny T-rex style, y=9-11) ===
        for y in 9...11 {
            for z in 7...9 {
                set(4, y, z, dinoGreen)
                set(11, y, z, dinoGreen)
            }
        }

        // === LEGS (y=1-5, two stumpy legs) ===
        for y in 1...5 {
            for z in 6...9 {
                set(5, y, z, dinoGreen)
                set(6, y, z, dinoGreen)
                set(9, y, z, dinoGreen)
                set(10, y, z, dinoGreen)
            }
        }

        // === FEET (y=0, wider than legs for cute look) ===
        for z in 5...10 {
            for x in 4...7 { set(x, 0, z, dinoGreen) }
            for x in 8...11 { set(x, 0, z, dinoGreen) }
        }

        // === TAIL (extends behind, tapering) ===
        for i in 0..<6 {
            let z = 4 - i
            if z < 0 { continue }
            let width = max(2, 4 - i)
            let startX = 8 - width / 2
            for dx in 0..<width {
                set(startX + dx, 7, z, dinoGreen)
                if i < 3 { set(startX + dx, 8, z, dinoGreen) }
            }
        }
        set(7, 7, 0, dinoDark)

        // === SPIKES (along back of head) ===
        for spikeY in [15, 18, 21] {
            set(7, spikeY, 2, dinoLight)
            set(8, spikeY, 2, dinoLight)
            set(7, spikeY + 1, 2, dinoLight)
            set(8, spikeY + 1, 2, dinoLight)
        }

        return voxels
    }

    // MARK: - Clothing Application

    private static func applyClothing(
        _ voxels: inout [VoxelPos: RGB],
        hatName: String, shirtName: String, accessoryName: String, heldItemName: String,
        hatColor: String, shirtColor: String, accessoryColor: String
    ) {
        func applyItem(_ def: ClothingDef?, colorOverride: String) {
            guard let def else { return }
            let color = palette[colorOverride] ?? palette[def.defaultColor] ?? dinoGreen
            for pos in def.positions {
                guard pos.x >= 0, pos.x < 16, pos.y >= 0, pos.y < 30, pos.z >= 0, pos.z < 16 else { continue }
                voxels[pos] = color
            }
        }

        applyItem(shirtDefs[shirtName], colorOverride: shirtColor)
        applyItem(hatDefs[hatName], colorOverride: hatColor)
        applyItem(accessoryDefs[accessoryName], colorOverride: accessoryColor)
        applyItem(heldItemDefs[heldItemName], colorOverride: accessoryColor)
    }

    // MARK: - Seeded Hash

    private static func hashSeed(_ seed: String) -> UInt64 {
        var hash: UInt64 = 5381
        for byte in seed.utf8 {
            hash = hash &* 33 &+ UInt64(byte)
        }
        return hash
    }

    private static func pick<T>(_ array: [T], hash: UInt64, shift: inout Int) -> T {
        let count = UInt64(array.count)
        let value = (hash >> shift) % count
        shift += Int(count.bitWidth - count.leadingZeroBitCount) + 1
        return array[Int(value)]
    }

    // MARK: - Public API

    static func generate(seed: String) -> [VoxelPos: RGB] {
        let hash = hashSeed(seed)
        var shift = 0

        let hat = pick(hatNames, hash: hash, shift: &shift)
        let shirt = pick(shirtNames, hash: hash, shift: &shift)
        let accessory = pick(accessoryNames, hash: hash, shift: &shift)
        let heldItem = pick(heldItemNames, hash: hash, shift: &shift)
        let hatColor = pick(clothingColorNames, hash: hash, shift: &shift)
        let shirtColor = pick(clothingColorNames, hash: hash, shift: &shift)
        let accColor = pick(clothingColorNames, hash: hash, shift: &shift)

        var model = createBaseDino()
        applyClothing(
            &model,
            hatName: hat, shirtName: shirt, accessoryName: accessory, heldItemName: heldItem,
            hatColor: hatColor, shirtColor: shirtColor, accessoryColor: accColor
        )
        return model
    }

    /// Builds a SceneKit scene from a voxel model for 3D rendering.
    static func buildScene(seed: String) -> SCNScene {
        let voxels = generate(seed: seed)
        let scene = SCNScene()

        let modelNode = SCNNode()
        var materialCache: [RGB: SCNMaterial] = [:]

        for (pos, color) in voxels {
            let box = SCNBox(width: 1, height: 1, length: 1, chamferRadius: 0)

            if materialCache[color] == nil {
                let mat = SCNMaterial()
                mat.diffuse.contents = color.nsColor
                mat.roughness.contents = NSNumber(value: 0.8)
                materialCache[color] = mat
            }
            box.firstMaterial = materialCache[color]

            let node = SCNNode(geometry: box)
            node.position = SCNVector3(
                Float(pos.x) - 8,
                Float(pos.y) - 11,
                Float(pos.z) - 8
            )
            modelNode.addChildNode(node)
        }

        let optimized = modelNode.flattenedClone()

        // Gentle floating bob
        let bob = SCNAction.repeatForever(
            SCNAction.sequence([
                SCNAction.moveBy(x: 0, y: 0.6, z: 0, duration: 1.8),
                SCNAction.moveBy(x: 0, y: -0.6, z: 0, duration: 1.8),
            ])
        )
        bob.timingMode = .easeInEaseOut
        optimized.runAction(bob)
        scene.rootNode.addChildNode(optimized)

        // Camera — front-on orthographic
        let camera = SCNCamera()
        camera.fieldOfView = 45
        camera.zNear = 1
        camera.zFar = 200
        camera.usesOrthographicProjection = true
        camera.orthographicScale = 16
        let cameraNode = SCNNode()
        cameraNode.camera = camera
        cameraNode.position = SCNVector3(10, 4, 38)
        cameraNode.look(at: SCNVector3(0, 2, 0))
        scene.rootNode.addChildNode(cameraNode)

        // Ambient light
        let ambientLight = SCNLight()
        ambientLight.type = .ambient
        ambientLight.color = NSColor(white: 0.5, alpha: 1)
        let ambientNode = SCNNode()
        ambientNode.light = ambientLight
        scene.rootNode.addChildNode(ambientNode)

        // Directional light — front-above
        let directionalLight = SCNLight()
        directionalLight.type = .directional
        directionalLight.color = NSColor(white: 0.7, alpha: 1)
        let lightNode = SCNNode()
        lightNode.light = directionalLight
        lightNode.position = SCNVector3(0, 20, 30)
        lightNode.look(at: SCNVector3(0, 0, 0))
        scene.rootNode.addChildNode(lightNode)

        scene.background.contents = NSColor.clear

        return scene
    }

    /// Builds a SceneKit scene showing only the dino's face/head (y >= 12).
    static func buildFaceScene(seed: String) -> SCNScene {
        let allVoxels = generate(seed: seed)
        let scene = SCNScene()

        // Filter to head region only (y >= 12 captures neck, head, hat, spikes)
        let headVoxels = allVoxels.filter { $0.key.y >= 12 }

        let modelNode = SCNNode()
        var materialCache: [RGB: SCNMaterial] = [:]

        // Center the head: head spans roughly y=12-28, x=3-12, z=2-14
        let centerY: Float = 17.5 // midpoint of head
        let centerX: Float = 7.5
        let centerZ: Float = 7.5

        for (pos, color) in headVoxels {
            let box = SCNBox(width: 1, height: 1, length: 1, chamferRadius: 0)

            if materialCache[color] == nil {
                let mat = SCNMaterial()
                mat.diffuse.contents = color.nsColor
                mat.roughness.contents = NSNumber(value: 0.8)
                materialCache[color] = mat
            }
            box.firstMaterial = materialCache[color]

            let node = SCNNode(geometry: box)
            node.position = SCNVector3(
                Float(pos.x) - centerX,
                Float(pos.y) - centerY,
                Float(pos.z) - centerZ
            )
            modelNode.addChildNode(node)
        }

        let optimized = modelNode.flattenedClone()

        // Gentle floating bob
        let bob = SCNAction.repeatForever(
            SCNAction.sequence([
                SCNAction.moveBy(x: 0, y: 0.4, z: 0, duration: 2.0),
                SCNAction.moveBy(x: 0, y: -0.4, z: 0, duration: 2.0),
            ])
        )
        bob.timingMode = .easeInEaseOut
        optimized.runAction(bob)
        scene.rootNode.addChildNode(optimized)

        // Camera — slight angle, tighter framing for face
        let camera = SCNCamera()
        camera.zNear = 1
        camera.zFar = 200
        camera.usesOrthographicProjection = true
        camera.orthographicScale = 9
        let cameraNode = SCNNode()
        cameraNode.camera = camera
        cameraNode.position = SCNVector3(5, 2, 30)
        cameraNode.look(at: SCNVector3(0, 1, 0))
        scene.rootNode.addChildNode(cameraNode)

        // Ambient light
        let ambientLight = SCNLight()
        ambientLight.type = .ambient
        ambientLight.color = NSColor(white: 0.5, alpha: 1)
        let ambientNode = SCNNode()
        ambientNode.light = ambientLight
        scene.rootNode.addChildNode(ambientNode)

        // Directional light — front-above
        let directionalLight = SCNLight()
        directionalLight.type = .directional
        directionalLight.color = NSColor(white: 0.7, alpha: 1)
        let lightNode = SCNNode()
        lightNode.light = directionalLight
        lightNode.position = SCNVector3(0, 15, 25)
        lightNode.look(at: SCNVector3(0, 0, 0))
        scene.rootNode.addChildNode(lightNode)

        scene.background.contents = NSColor.clear

        return scene
    }
}
