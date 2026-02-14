import VellumAssistantShared
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

/// SpriteKit scene managing the egg hatch animation with progressive shell fragment reveal.
final class EggHatchScene: SKScene {
    weak var hatchDelegate: EggHatchSceneDelegate?

    // Nodes
    private var eggContainer: SKNode!
    private var fragmentNodes: [PixelSpriteBuilder.FragmentInfo] = []
    private var glowNode: SKEffectNode!
    private var glowSpriteNode: SKSpriteNode!
    private var dinoNode: SKSpriteNode!

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
        let ps = Meadow.artPixelSize

        // Build dino sprite (behind egg, starts invisible)
        let (dinoTex, dinoSize) = PixelSpriteBuilder.buildTexture(from: PixelArtData.dino, pixelSize: ps)
        dinoNode = SKSpriteNode(texture: dinoTex, size: dinoSize)
        dinoNode.position = CGPoint(x: 0, y: 10)
        dinoNode.zPosition = 8
        dinoNode.alpha = 0
        addChild(dinoNode)

        // Build egg container with 7 fragment sprites
        eggContainer = SKNode()
        eggContainer.position = CGPoint(x: 0, y: 10)
        eggContainer.zPosition = 10
        addChild(eggContainer)

        fragmentNodes = PixelSpriteBuilder.buildEggFragments(pixelSize: ps)
        for frag in fragmentNodes {
            frag.sprite.position = frag.centerOffset
            frag.sprite.zPosition = 10
            eggContainer.addChild(frag.sprite)
        }
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
        guard eggContainer != nil else { return }
        let floatUp = SKAction.moveBy(x: 0, y: 5, duration: 1.5)
        floatUp.timingMode = .easeInEaseOut
        let floatDown = floatUp.reversed()
        let floatAction = SKAction.repeatForever(SKAction.sequence([floatUp, floatDown]))
        idleFloatAction = floatAction
        eggContainer.run(floatAction, withKey: "idleFloat")
        dinoNode?.run(floatAction, withKey: "idleFloat")
    }

    // MARK: - Public API

    func setCrackProgress(_ progress: CGFloat, animated: Bool) {
        guard !hasFullyHatched, eggContainer != nil, glowSpriteNode != nil else { return }
        currentProgress = progress

        // Interpolate fragment drifts
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

        // Fade dino in: alpha 0 at progress ≤0.10, alpha 1 at progress ≥0.40
        let dinoAlpha: CGFloat
        if progress <= 0.10 {
            dinoAlpha = 0
        } else if progress >= 0.40 {
            dinoAlpha = 1
        } else {
            dinoAlpha = (progress - 0.10) / 0.30
        }

        if animated {
            dinoNode?.run(SKAction.fadeAlpha(to: dinoAlpha, duration: duration))
        } else {
            dinoNode?.alpha = dinoAlpha
        }

        // Intensify glow as progress increases
        let glowAlpha = 0.3 + progress * 0.5
        glowSpriteNode.run(SKAction.fadeAlpha(to: glowAlpha, duration: animated ? 0.5 : 0))
    }

    func triggerDramaticCrack(for step: Int) {
        guard eggContainer != nil else { return }

        // Stop idle float
        eggContainer.removeAction(forKey: "idleFloat")
        dinoNode?.removeAction(forKey: "idleFloat")

        // Violent shake on egg container
        let shakeRight = SKAction.moveBy(x: 6, y: 0, duration: 0.04)
        let shakeLeft = SKAction.moveBy(x: -12, y: 0, duration: 0.04)
        let shakeCenter = SKAction.moveBy(x: 6, y: 0, duration: 0.04)
        let shakeSeq = SKAction.sequence([shakeRight, shakeLeft, shakeCenter])
        let shake = SKAction.repeat(shakeSeq, count: 6)

        // Bright flash
        let flash = SKSpriteNode(color: .white, size: CGSize(width: 300, height: 300))
        flash.position = eggContainer.position
        flash.alpha = 0
        flash.zPosition = 50
        addChild(flash)

        let flashIn = SKAction.fadeAlpha(to: 0.7, duration: 0.1)
        let flashOut = SKAction.fadeAlpha(to: 0, duration: 0.4)
        let removeFlash = SKAction.removeFromParent()
        flash.run(SKAction.sequence([flashIn, flashOut, removeFlash]))

        // Crack sparkles
        spawnCrackSparkles()

        // Per-fragment jitter during shake
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
            // Restore position to base (the shake displaces it)
            self.eggContainer.position = CGPoint(x: 0, y: 10)
            self.dinoNode?.position = CGPoint(x: 0, y: 10)
            self.startIdleAnimations()
            self.hatchDelegate?.sceneDidComplete(.dramaticCrackDone)
        }
    }

    func triggerFullHatch() {
        guard eggContainer != nil, !hasFullyHatched else { return }
        hasFullyHatched = true

        // Stop all idle
        eggContainer.removeAllActions()
        dinoNode?.removeAllActions()

        // White flash
        let flash = SKSpriteNode(color: .white, size: CGSize(width: 400, height: 400))
        flash.position = eggContainer.position
        flash.alpha = 0
        flash.zPosition = 50
        addChild(flash)
        flash.run(SKAction.sequence([
            SKAction.fadeAlpha(to: 0.85, duration: 0.15),
            SKAction.fadeAlpha(to: 0, duration: 0.6),
            SKAction.removeFromParent(),
        ]))

        // Reparent fragments to scene root for independent physics
        for frag in fragmentNodes {
            let worldPos = eggContainer.convert(frag.sprite.position, to: self)
            let worldRotation = frag.sprite.zRotation
            frag.sprite.removeFromParent()
            frag.sprite.position = worldPos
            frag.sprite.zRotation = worldRotation
            frag.sprite.zPosition = 20
            addChild(frag.sprite)

            // Add physics body
            frag.sprite.physicsBody = SKPhysicsBody(rectangleOf: frag.sprite.size)
            frag.sprite.physicsBody?.affectedByGravity = true
            frag.sprite.physicsBody?.collisionBitMask = 0
            frag.sprite.physicsBody?.contactTestBitMask = 0
            frag.sprite.physicsBody?.linearDamping = 0.5
            frag.sprite.physicsBody?.angularDamping = 0.3

            // Apply burst impulse
            if frag.index < EggFragmentMap.burstVelocities.count {
                let v = EggFragmentMap.burstVelocities[frag.index]
                frag.sprite.physicsBody?.applyImpulse(CGVector(dx: v.dx * 0.12, dy: v.dy * 0.12))
                frag.sprite.physicsBody?.applyAngularImpulse(v.angularImpulse)
            }

            // Fade and remove
            frag.sprite.run(SKAction.sequence([
                SKAction.wait(forDuration: 0.8),
                SKAction.fadeOut(withDuration: 0.4),
                SKAction.removeFromParent(),
            ]))
        }

        // Remove egg container
        eggContainer.removeFromParent()

        // Show creature celebration
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
        guard let dinoNode else { return }

        // Ensure dino is fully visible and in position
        dinoNode.alpha = 1
        dinoNode.position = CGPoint(x: 0, y: 10)
        dinoNode.setScale(0)

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

        dinoNode.run(SKAction.sequence([appear, settle, bounceUp, bounceDown])) { [weak self] in
            // Start breathing idle
            let breatheUp = SKAction.scaleY(to: 1.03, duration: 1.5)
            breatheUp.timingMode = .easeInEaseOut
            let breatheDown = SKAction.scaleY(to: 1.0, duration: 1.5)
            breatheDown.timingMode = .easeInEaseOut
            dinoNode.run(SKAction.repeatForever(SKAction.sequence([breatheUp, breatheDown])))

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
