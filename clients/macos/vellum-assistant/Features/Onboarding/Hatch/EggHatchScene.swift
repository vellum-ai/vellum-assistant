import VellumAssistantShared
import SpriteKit
import AppKit

/// Delegate protocol for SpriteKit to SwiftUI communication.
protocol EggHatchSceneDelegate: AnyObject {
    func sceneDidComplete(_ event: HatchEvent)
}

enum HatchEvent {
    case firstCrackDone
    case dramaticCrackDone
    case fullHatchDone
}

/// SpriteKit scene managing the egg hatch animation with progressive shell fragment reveal.
/// Post-dino removal: the "creature" is now a simple colored circle avatar placeholder.
final class EggHatchScene: SKScene {
    weak var hatchDelegate: EggHatchSceneDelegate?

    // Nodes
    private var eggContainer: SKNode!
    private var fragmentNodes: [FragmentInfo] = []
    private var glowNode: SKEffectNode!
    private var glowSpriteNode: SKSpriteNode!
    private var creatureNode: SKShapeNode!

    // State
    private var currentProgress: CGFloat = 0
    private var hasFullyHatched = false
    private var idleFloatAction: SKAction?

    private struct FragmentInfo {
        let index: Int
        let sprite: SKSpriteNode
        let centerOffset: CGPoint
    }

    // MARK: - Scene Setup

    override func didMove(to view: SKView) {
        backgroundColor = .clear
        scaleMode = .resizeFill
        anchorPoint = CGPoint(x: 0.5, y: 0.5)

        setupGlow()
        setupEgg()
        setupFireflies()
        startIdleAnimations()
    }

    private func setupEgg() {
        let ps = Meadow.artPixelSize

        // Build creature node (colored circle, starts invisible)
        let creatureRadius: CGFloat = 40
        creatureNode = SKShapeNode(circleOfRadius: creatureRadius)
        creatureNode.fillColor = NSColor(VColor.primaryBase)
        creatureNode.strokeColor = NSColor(VColor.borderActive)
        creatureNode.lineWidth = 2
        creatureNode.position = CGPoint(x: 0, y: 10)
        creatureNode.zPosition = 8
        creatureNode.alpha = 0
        addChild(creatureNode)

        // Build egg container with fragment sprites from the egg grid
        eggContainer = SKNode()
        eggContainer.position = CGPoint(x: 0, y: 10)
        eggContainer.zPosition = 10
        addChild(eggContainer)

        // Build simple egg fragments using the egg pixel data and fragment map
        let grid = PixelArtData.egg
        let map = EggFragmentMap.fragmentMap
        let rows = grid.count
        let cols = grid[0].count

        for frag in 0..<7 {
            var minR = rows, maxR = 0, minC = cols, maxC = 0
            for r in 0..<rows {
                for c in 0..<cols {
                    if map[r][c] == frag {
                        minR = min(minR, r)
                        maxR = max(maxR, r)
                        minC = min(minC, c)
                        maxC = max(maxC, c)
                    }
                }
            }
            guard minR <= maxR, minC <= maxC else { continue }

            let subRows = maxR - minR + 1
            let subCols = maxC - minC + 1
            var subGrid = [[UInt32?]](repeating: [UInt32?](repeating: nil, count: subCols), count: subRows)
            for r in minR...maxR {
                for c in minC...maxC {
                    if map[r][c] == frag {
                        subGrid[r - minR][c - minC] = grid[r][c]
                    }
                }
            }

            let sprite = buildSpriteFromGrid(subGrid, pixelSize: ps)

            let eggCenterX = CGFloat(cols) * ps / 2
            let eggCenterY = CGFloat(rows) * ps / 2
            let fragCenterX = (CGFloat(minC) + CGFloat(subCols) / 2) * ps
            let fragCenterY = (CGFloat(minR) + CGFloat(subRows) / 2) * ps

            let offsetX = fragCenterX - eggCenterX
            let offsetY = eggCenterY - fragCenterY

            let info = FragmentInfo(index: frag, sprite: sprite, centerOffset: CGPoint(x: offsetX, y: offsetY))
            fragmentNodes.append(info)

            sprite.position = info.centerOffset
            sprite.zPosition = 10
            eggContainer.addChild(sprite)
        }
    }

    /// Build an SKSpriteNode from a pixel grid using CGBitmapContext.
    private func buildSpriteFromGrid(_ grid: [[UInt32?]], pixelSize: CGFloat) -> SKSpriteNode {
        let rows = grid.count
        let cols = grid[0].count
        let width = Int(CGFloat(cols) * pixelSize)
        let height = Int(CGFloat(rows) * pixelSize)

        let colorSpace = CGColorSpaceCreateDeviceRGB()
        guard let context = CGContext(
            data: nil,
            width: width,
            height: height,
            bitsPerComponent: 8,
            bytesPerRow: width * 4,
            space: colorSpace,
            bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
        ) else {
            return SKSpriteNode()
        }

        let ps = Int(pixelSize)
        for row in 0..<rows {
            for col in 0..<cols {
                guard let hex = grid[row][col] else { continue }
                let r = CGFloat((hex >> 16) & 0xFF) / 255.0
                let g = CGFloat((hex >> 8) & 0xFF) / 255.0
                let b = CGFloat(hex & 0xFF) / 255.0
                context.setFillColor(red: r, green: g, blue: b, alpha: 1.0)
                let x = col * ps
                let y = (rows - 1 - row) * ps
                context.fill(CGRect(x: x, y: y, width: ps, height: ps))
            }
        }

        guard let cgImage = context.makeImage() else {
            return SKSpriteNode()
        }

        let texture = SKTexture(cgImage: cgImage)
        texture.filteringMode = .nearest
        return SKSpriteNode(texture: texture, size: CGSize(width: width, height: height))
    }

    private func setupGlow() {
        glowNode = SKEffectNode()
        glowNode.shouldRasterize = true
        glowNode.filter = CIFilter(name: "CIGaussianBlur", parameters: ["inputRadius": 20.0])
        glowNode.zPosition = 5

        glowSpriteNode = SKSpriteNode(color: NSColor(Meadow.eggGlow), size: CGSize(width: 160, height: 200))
        glowSpriteNode.alpha = 0.3
        glowNode.addChild(glowSpriteNode)
        glowNode.position = CGPoint(x: 0, y: 10)
        addChild(glowNode)

        let pulseUp = SKAction.run { [weak self] in
            self?.glowSpriteNode.run(SKAction.fadeAlpha(to: 0.5, duration: 1.5))
        }
        let pulseDown = SKAction.run { [weak self] in
            self?.glowSpriteNode.run(SKAction.fadeAlpha(to: 0.3, duration: 1.5))
        }
        let wait = SKAction.wait(forDuration: 1.5)
        glowNode.run(SKAction.repeatForever(SKAction.sequence([pulseUp, wait, pulseDown, wait])))
    }

    private func setupFireflies() {
        let colors: [NSColor] = [
            NSColor(Meadow.eggGlow).withAlphaComponent(0.6),
            NSColor(Meadow.eggGlowIntense).withAlphaComponent(0.5),
            NSColor(Meadow.crackLight).withAlphaComponent(0.4),
        ]

        for i in 0..<5 {
            let dot = SKShapeNode(circleOfRadius: 2)
            dot.fillColor = colors[i % colors.count]
            dot.strokeColor = .clear
            dot.alpha = 0
            dot.zPosition = 3
            dot.position = CGPoint(
                x: CGFloat.random(in: -100...100),
                y: CGFloat.random(in: -80...80)
            )
            addChild(dot)

            let dur = CGFloat.random(in: 6...9)
            let fadeIn = SKAction.fadeAlpha(to: CGFloat.random(in: 0.3...0.7), duration: Double(dur / 2))
            let fadeOut = SKAction.fadeAlpha(to: 0.05, duration: Double(dur / 2))
            let moveBy = SKAction.moveBy(
                x: CGFloat.random(in: -40...40),
                y: CGFloat.random(in: -30...30),
                duration: Double(dur)
            )
            let moveBack = moveBy.reversed()
            let group1 = SKAction.group([fadeIn, moveBy])
            let group2 = SKAction.group([fadeOut, moveBack])
            dot.run(SKAction.repeatForever(SKAction.sequence([
                SKAction.wait(forDuration: Double(i) * 0.8),
                group1,
                group2,
            ])))
        }
    }

    // MARK: - Idle Animations

    private func startIdleAnimations() {
        guard eggContainer != nil else { return }
        let floatUp = SKAction.moveBy(x: 0, y: 5, duration: 1.5)
        floatUp.timingMode = .easeInEaseOut
        let floatDown = floatUp.reversed()
        let floatAction = SKAction.repeatForever(SKAction.sequence([floatUp, floatDown]))
        idleFloatAction = floatAction
        eggContainer.run(floatAction, withKey: "idleFloat")
        creatureNode?.run(floatAction, withKey: "idleFloat")
    }

    // MARK: - Public API

    func setCrackProgress(_ progress: CGFloat, animated: Bool) {
        guard !hasFullyHatched, eggContainer != nil, glowSpriteNode != nil else { return }
        currentProgress = progress

        let drifts = EggFragmentMap.interpolatedDrifts(for: progress)
        let duration: TimeInterval = animated ? 0.5 : 0

        for frag in fragmentNodes {
            guard frag.index < drifts.count else { continue }
            let drift = drifts[frag.index]
            let targetPos = CGPoint(
                x: frag.centerOffset.x + drift.dx,
                y: frag.centerOffset.y + drift.dy
            )

            if animated {
                frag.sprite.run(SKAction.group([
                    SKAction.move(to: targetPos, duration: duration),
                    SKAction.rotate(toAngle: drift.rotation, duration: duration),
                ]))
            } else {
                frag.sprite.position = targetPos
                frag.sprite.zRotation = drift.rotation
            }
        }

        // Fade creature in
        let creatureAlpha: CGFloat
        if progress <= 0.10 {
            creatureAlpha = 0
        } else if progress >= 0.40 {
            creatureAlpha = 1
        } else {
            creatureAlpha = (progress - 0.10) / 0.30
        }

        if animated {
            creatureNode?.run(SKAction.fadeAlpha(to: creatureAlpha, duration: duration))
        } else {
            creatureNode?.alpha = creatureAlpha
        }

        let glowAlpha = 0.3 + progress * 0.5
        glowSpriteNode.run(SKAction.fadeAlpha(to: glowAlpha, duration: animated ? 0.5 : 0))
    }

    func triggerDramaticCrack(for step: Int) {
        guard eggContainer != nil else { return }

        eggContainer.removeAction(forKey: "idleFloat")
        creatureNode?.removeAction(forKey: "idleFloat")

        let shakeRight = SKAction.moveBy(x: 6, y: 0, duration: 0.04)
        let shakeLeft = SKAction.moveBy(x: -12, y: 0, duration: 0.04)
        let shakeCenter = SKAction.moveBy(x: 6, y: 0, duration: 0.04)
        let shakeSeq = SKAction.sequence([shakeRight, shakeLeft, shakeCenter])
        let shake = SKAction.repeat(shakeSeq, count: 6)

        let flash = SKSpriteNode(color: NSColor(VColor.auxWhite), size: CGSize(width: 300, height: 300))
        flash.position = eggContainer.position
        flash.alpha = 0
        flash.zPosition = 50
        addChild(flash)

        let flashIn = SKAction.fadeAlpha(to: 0.7, duration: 0.1)
        let flashOut = SKAction.fadeAlpha(to: 0, duration: 0.4)
        let removeFlash = SKAction.removeFromParent()
        flash.run(SKAction.sequence([flashIn, flashOut, removeFlash]))

        spawnCrackSparkles()

        for frag in fragmentNodes {
            let jitterX = CGFloat.random(in: -3...3)
            let jitterY = CGFloat.random(in: -3...3)
            let jitter = SKAction.sequence([
                SKAction.moveBy(x: jitterX, y: jitterY, duration: 0.05),
                SKAction.moveBy(x: -jitterX, y: -jitterY, duration: 0.05),
            ])
            frag.sprite.run(SKAction.repeat(jitter, count: 4))
        }

        eggContainer.run(shake) { [weak self] in
            guard let self else { return }
            self.eggContainer.position = CGPoint(x: 0, y: 10)
            self.creatureNode?.position = CGPoint(x: 0, y: 10)
            self.startIdleAnimations()
            self.hatchDelegate?.sceneDidComplete(.dramaticCrackDone)
        }
    }

    func triggerFullHatch() {
        guard eggContainer != nil, !hasFullyHatched else { return }
        hasFullyHatched = true

        eggContainer.removeAllActions()
        creatureNode?.removeAllActions()

        let flash = SKSpriteNode(color: NSColor(VColor.auxWhite), size: CGSize(width: 400, height: 400))
        flash.position = eggContainer.position
        flash.alpha = 0
        flash.zPosition = 50
        addChild(flash)
        flash.run(SKAction.sequence([
            SKAction.fadeAlpha(to: 0.85, duration: 0.15),
            SKAction.fadeAlpha(to: 0, duration: 0.6),
            SKAction.removeFromParent(),
        ]))

        for frag in fragmentNodes {
            let worldPos = eggContainer.convert(frag.sprite.position, to: self)
            let worldRotation = frag.sprite.zRotation
            frag.sprite.removeFromParent()
            frag.sprite.position = worldPos
            frag.sprite.zRotation = worldRotation
            frag.sprite.zPosition = 20
            addChild(frag.sprite)

            frag.sprite.physicsBody = SKPhysicsBody(rectangleOf: frag.sprite.size)
            frag.sprite.physicsBody?.affectedByGravity = true
            frag.sprite.physicsBody?.collisionBitMask = 0
            frag.sprite.physicsBody?.contactTestBitMask = 0
            frag.sprite.physicsBody?.linearDamping = 0.5
            frag.sprite.physicsBody?.angularDamping = 0.3

            if frag.index < EggFragmentMap.burstVelocities.count {
                let v = EggFragmentMap.burstVelocities[frag.index]
                frag.sprite.physicsBody?.applyImpulse(CGVector(dx: v.dx * 0.12, dy: v.dy * 0.12))
                frag.sprite.physicsBody?.applyAngularImpulse(v.angularImpulse)
            }

            frag.sprite.run(SKAction.sequence([
                SKAction.wait(forDuration: 0.8),
                SKAction.fadeOut(withDuration: 0.4),
                SKAction.removeFromParent(),
            ]))
        }

        eggContainer.removeFromParent()

        DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) { [weak self] in
            self?.showCreature()
        }
    }

    // MARK: - Crack Sparkles

    private func spawnCrackSparkles() {
        let sparklePositions: [CGPoint] = [
            CGPoint(x: -10, y: 20),
            CGPoint(x: 15, y: -5),
            CGPoint(x: -5, y: -15),
            CGPoint(x: 20, y: 10),
        ]

        for pos in sparklePositions {
            let sparkle = SKShapeNode(circleOfRadius: 3)
            sparkle.fillColor = NSColor(Meadow.crackLight)
            sparkle.strokeColor = .clear
            sparkle.position = CGPoint(
                x: eggContainer.position.x + pos.x,
                y: eggContainer.position.y + pos.y
            )
            sparkle.zPosition = 15
            sparkle.alpha = 0
            addChild(sparkle)

            let appear = SKAction.fadeIn(withDuration: 0.1)
            let grow = SKAction.scale(to: 1.5, duration: 0.2)
            let fadeAndShrink = SKAction.group([
                SKAction.fadeOut(withDuration: 0.4),
                SKAction.scale(to: 0, duration: 0.4),
            ])
            sparkle.run(SKAction.sequence([appear, grow, fadeAndShrink, SKAction.removeFromParent()]))
        }
    }

    // MARK: - Creature

    private func showCreature() {
        guard let creatureNode else { return }

        creatureNode.alpha = 1
        creatureNode.position = CGPoint(x: 0, y: 10)
        creatureNode.setScale(0)

        let appear = SKAction.group([
            SKAction.fadeIn(withDuration: 0.2),
            SKAction.scale(to: 1.1, duration: 0.3),
        ])
        appear.timingMode = .easeOut
        let settle = SKAction.scale(to: 1.0, duration: 0.2)
        settle.timingMode = .easeInEaseOut

        let bounceUp = SKAction.moveBy(x: 0, y: 15, duration: 0.3)
        bounceUp.timingMode = .easeOut
        let bounceDown = SKAction.moveBy(x: 0, y: -15, duration: 0.2)
        bounceDown.timingMode = .easeIn

        creatureNode.run(SKAction.sequence([appear, settle, bounceUp, bounceDown])) { [weak self] in
            let breatheUp = SKAction.scaleY(to: 1.03, duration: 1.5)
            breatheUp.timingMode = .easeInEaseOut
            let breatheDown = SKAction.scaleY(to: 1.0, duration: 1.5)
            breatheDown.timingMode = .easeInEaseOut
            creatureNode.run(SKAction.repeatForever(SKAction.sequence([breatheUp, breatheDown])))

            self?.spawnCelebration()
            self?.hatchDelegate?.sceneDidComplete(.fullHatchDone)
        }
    }

    private func spawnCelebration() {
        for _ in 0..<12 {
            let sparkle = SKShapeNode(circleOfRadius: CGFloat.random(in: 2...4))
            sparkle.fillColor = NSColor(Meadow.eggGlow)
            sparkle.strokeColor = .clear
            sparkle.position = CGPoint(x: 0, y: 10)
            sparkle.zPosition = 25
            sparkle.alpha = 0.8
            addChild(sparkle)

            let angle = CGFloat.random(in: 0...(2 * .pi))
            let distance = CGFloat.random(in: 60...120)
            let dx = cos(angle) * distance
            let dy = sin(angle) * distance

            let move = SKAction.moveBy(x: dx, y: dy, duration: Double.random(in: 0.8...1.4))
            move.timingMode = .easeOut
            let fade = SKAction.fadeOut(withDuration: 1.0)
            let shrink = SKAction.scale(to: 0.2, duration: 1.2)
            let group = SKAction.group([move, fade, shrink])
            sparkle.run(SKAction.sequence([group, SKAction.removeFromParent()]))
        }
    }
}
