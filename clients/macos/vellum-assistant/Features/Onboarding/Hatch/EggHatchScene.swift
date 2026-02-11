import SpriteKit
import AppKit

/// Delegate protocol for SpriteKit → SwiftUI communication.
protocol EggHatchSceneDelegate: AnyObject {
    func sceneDidComplete(_ event: HatchEvent)
}

enum HatchEvent {
    case firstCrackDone
    case dramaticCrackDone
    case fullHatchDone
}

/// SpriteKit scene managing the egg hatch animation with progressive cracking.
final class EggHatchScene: SKScene {
    weak var hatchDelegate: EggHatchSceneDelegate?

    // Nodes
    private var eggNode: SKSpriteNode!
    private var crackNodes: [SKShapeNode] = []
    private var glowNode: SKEffectNode!
    private var glowSpriteNode: SKSpriteNode!
    private var creatureNode: SKSpriteNode?
    private var shellPieces: [SKSpriteNode] = []

    // State
    private var currentProgress: CGFloat = 0
    private var hasFullyHatched = false
    private var idleFloatAction: SKAction?

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
        // Load egg.jpg from bundle
        if let url = Bundle.module.url(forResource: "egg", withExtension: "jpg"),
           let nsImage = NSImage(contentsOf: url) {
            let texture = SKTexture(image: nsImage)
            texture.filteringMode = .nearest
            eggNode = SKSpriteNode(texture: texture)
        } else {
            // Fallback: colored oval
            eggNode = SKSpriteNode(color: .orange, size: CGSize(width: 120, height: 156))
        }

        eggNode.size = CGSize(width: 120, height: 156)
        eggNode.position = CGPoint(x: 0, y: 10)
        eggNode.zPosition = 10
        addChild(eggNode)
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

        // Glow pulse
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
        guard eggNode != nil else { return }
        let floatUp = SKAction.moveBy(x: 0, y: 5, duration: 1.5)
        floatUp.timingMode = .easeInEaseOut
        let floatDown = floatUp.reversed()
        let floatAction = SKAction.repeatForever(SKAction.sequence([floatUp, floatDown]))
        idleFloatAction = floatAction
        eggNode.run(floatAction, withKey: "idleFloat")
    }

    // MARK: - Public API

    func setCrackProgress(_ progress: CGFloat, animated: Bool) {
        guard !hasFullyHatched else { return }
        let oldProgress = currentProgress
        currentProgress = progress

        // Remove existing crack nodes
        crackNodes.forEach { $0.removeFromParent() }
        crackNodes.removeAll()

        // Draw cracks for current progress
        let sets = CrackGeometry.sets(for: progress)
        for crackSet in sets {
            for path in crackSet.paths {
                guard path.count >= 2 else { continue }
                let crackPath = CGMutablePath()
                // Scale from 200×260 coordinate space to egg node size
                let scaleX = eggNode.size.width / 200.0
                let scaleY = eggNode.size.height / 260.0
                let offsetX = -eggNode.size.width / 2
                let offsetY = -eggNode.size.height / 2

                crackPath.move(to: CGPoint(
                    x: path[0].x * scaleX + offsetX,
                    y: (260 - path[0].y) * scaleY + offsetY
                ))
                for i in 1..<path.count {
                    crackPath.addLine(to: CGPoint(
                        x: path[i].x * scaleX + offsetX,
                        y: (260 - path[i].y) * scaleY + offsetY
                    ))
                }

                // Glow line (wider, semi-transparent)
                let glowLine = SKShapeNode(path: crackPath)
                glowLine.strokeColor = NSColor(Meadow.crackLight).withAlphaComponent(0.5)
                glowLine.lineWidth = crackSet.glowWidth
                glowLine.lineCap = .round
                glowLine.zPosition = 11
                glowLine.position = eggNode.position
                addChild(glowLine)
                crackNodes.append(glowLine)

                // Sharp crack line
                let crackLine = SKShapeNode(path: crackPath)
                crackLine.strokeColor = NSColor(Meadow.crackLight)
                crackLine.lineWidth = crackSet.lineWidth
                crackLine.lineCap = .round
                crackLine.zPosition = 12
                crackLine.position = eggNode.position
                addChild(crackLine)
                crackNodes.append(crackLine)

                if animated && progress > oldProgress {
                    crackLine.alpha = 0
                    glowLine.alpha = 0
                    crackLine.run(SKAction.fadeIn(withDuration: 0.3))
                    glowLine.run(SKAction.fadeIn(withDuration: 0.3))
                }
            }
        }

        // Intensify glow as progress increases
        let glowAlpha = 0.3 + progress * 0.5
        glowSpriteNode.run(SKAction.fadeAlpha(to: glowAlpha, duration: animated ? 0.5 : 0))
    }

    func triggerDramaticCrack(for step: Int) {
        guard eggNode != nil else { return }

        // Stop idle float
        eggNode.removeAction(forKey: "idleFloat")

        // Violent shake
        let shakeRight = SKAction.moveBy(x: 6, y: 0, duration: 0.04)
        let shakeLeft = SKAction.moveBy(x: -12, y: 0, duration: 0.04)
        let shakeCenter = SKAction.moveBy(x: 6, y: 0, duration: 0.04)
        let shakeSeq = SKAction.sequence([shakeRight, shakeLeft, shakeCenter])
        let shake = SKAction.repeat(shakeSeq, count: 6)

        // Bright flash
        let flash = SKSpriteNode(color: .white, size: CGSize(width: 300, height: 300))
        flash.position = eggNode.position
        flash.alpha = 0
        flash.zPosition = 50
        addChild(flash)

        let flashIn = SKAction.fadeAlpha(to: 0.7, duration: 0.1)
        let flashOut = SKAction.fadeAlpha(to: 0, duration: 0.4)
        let removeFlash = SKAction.removeFromParent()
        flash.run(SKAction.sequence([flashIn, flashOut, removeFlash]))

        // Crack sparkles at crack endpoints
        spawnCrackSparkles()

        eggNode.run(shake) { [weak self] in
            // Resume float
            self?.startIdleAnimations()
            self?.hatchDelegate?.sceneDidComplete(.dramaticCrackDone)
        }
    }

    func triggerFullHatch() {
        guard eggNode != nil, !hasFullyHatched else { return }
        hasFullyHatched = true

        // Stop all egg animations
        eggNode.removeAllActions()

        // White flash
        let flash = SKSpriteNode(color: .white, size: CGSize(width: 400, height: 400))
        flash.position = eggNode.position
        flash.alpha = 0
        flash.zPosition = 50
        addChild(flash)
        flash.run(SKAction.sequence([
            SKAction.fadeAlpha(to: 0.85, duration: 0.15),
            SKAction.fadeAlpha(to: 0, duration: 0.6),
            SKAction.removeFromParent(),
        ]))

        // Spawn shell pieces with physics
        spawnShellPieces()

        // Egg flies up and fades
        let eggFly = SKAction.group([
            SKAction.moveBy(x: 0, y: 60, duration: 0.4),
            SKAction.fadeOut(withDuration: 0.4),
            SKAction.scale(to: 0.3, duration: 0.4),
        ])
        eggNode.run(eggFly)

        // Remove cracks
        crackNodes.forEach { node in
            node.run(SKAction.sequence([
                SKAction.fadeOut(withDuration: 0.2),
                SKAction.removeFromParent(),
            ]))
        }
        crackNodes.removeAll()

        // Show creature after delay
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) { [weak self] in
            self?.showCreature()
        }
    }

    // MARK: - Shell Pieces

    private func spawnShellPieces() {
        let shellColors: [NSColor] = [
            NSColor(Amber._400),
            NSColor(Amber._500),
            NSColor(Amber._600),
        ]
        let velocities: [(dx: CGFloat, dy: CGFloat)] = [
            (-120, 180), (130, 160), (-160, 60),
            (170, 40), (-80, 200), (90, 190),
        ]

        for i in 0..<6 {
            let piece = SKSpriteNode(color: shellColors[i % 3], size: CGSize(width: 14, height: 14))
            piece.position = eggNode.position
            piece.zPosition = 20

            // Physics for tumbling
            piece.physicsBody = SKPhysicsBody(rectangleOf: piece.size)
            piece.physicsBody?.affectedByGravity = true
            piece.physicsBody?.collisionBitMask = 0
            piece.physicsBody?.contactTestBitMask = 0
            piece.physicsBody?.linearDamping = 0.5
            piece.physicsBody?.angularDamping = 0.3
            addChild(piece)
            shellPieces.append(piece)

            // Apply impulse
            let v = velocities[i]
            piece.physicsBody?.applyImpulse(CGVector(dx: v.dx * 0.1, dy: v.dy * 0.1))
            piece.physicsBody?.applyAngularImpulse(CGFloat.random(in: -0.5...0.5))

            // Fade and remove
            piece.run(SKAction.sequence([
                SKAction.wait(forDuration: 0.8),
                SKAction.fadeOut(withDuration: 0.4),
                SKAction.removeFromParent(),
            ]))
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
                x: eggNode.position.x + pos.x,
                y: eggNode.position.y + pos.y
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
        if let url = Bundle.module.url(forResource: "dino", withExtension: "webp"),
           let nsImage = NSImage(contentsOf: url) {
            let texture = SKTexture(image: nsImage)
            texture.filteringMode = .nearest
            creatureNode = SKSpriteNode(texture: texture)
        } else {
            creatureNode = SKSpriteNode(color: .purple, size: CGSize(width: 80, height: 72))
        }

        guard let creature = creatureNode else { return }
        creature.size = CGSize(width: 120, height: 108)
        creature.position = CGPoint(x: 0, y: 10)
        creature.zPosition = 30
        creature.setScale(0)
        creature.alpha = 0
        addChild(creature)

        // Spring entrance
        let appear = SKAction.group([
            SKAction.fadeIn(withDuration: 0.2),
            SKAction.scale(to: 1.1, duration: 0.3),
        ])
        appear.timingMode = .easeOut
        let settle = SKAction.scale(to: 1.0, duration: 0.2)
        settle.timingMode = .easeInEaseOut

        // Bounce
        let bounceUp = SKAction.moveBy(x: 0, y: 15, duration: 0.3)
        bounceUp.timingMode = .easeOut
        let bounceDown = SKAction.moveBy(x: 0, y: -15, duration: 0.2)
        bounceDown.timingMode = .easeIn

        creature.run(SKAction.sequence([appear, settle, bounceUp, bounceDown])) { [weak self] in
            // Start breathing idle
            let breatheUp = SKAction.scaleY(to: 1.03, duration: 1.5)
            breatheUp.timingMode = .easeInEaseOut
            let breatheDown = SKAction.scaleY(to: 1.0, duration: 1.5)
            breatheDown.timingMode = .easeInEaseOut
            creature.run(SKAction.repeatForever(SKAction.sequence([breatheUp, breatheDown])))

            // Celebration sparkles
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
