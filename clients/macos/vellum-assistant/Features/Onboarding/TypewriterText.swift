import VellumAssistantShared
import SwiftUI

struct TypewriterText: View {
    let fullText: String
    var speed: TimeInterval = 0.05
    var font: Font = VFont.onboardingTitle
    var onComplete: (() -> Void)? = nil

    @State private var displayedText = ""
    @State private var timer: Timer?
    @State private var charIndex = 0

    var body: some View {
        ZStack {
            // Invisible full text reserves the final height
            Text(fullText)
                .font(font)
                .foregroundColor(.clear)
                .fixedSize(horizontal: false, vertical: true)
                .accessibilityHidden(true)

            Text(displayedText)
                .font(font)
                .foregroundColor(VColor.contentDefault)
                .fixedSize(horizontal: false, vertical: true)
        }
        .onAppear {
            startTyping()
        }
        .onDisappear {
            timer?.invalidate()
        }
    }

    private func startTyping() {
        displayedText = ""
        charIndex = 0
        let characters = Array(fullText)
        timer = Timer.scheduledTimer(withTimeInterval: speed, repeats: true) { t in
            if charIndex < characters.count {
                displayedText.append(characters[charIndex])
                charIndex += 1
            } else {
                t.invalidate()
                onComplete?()
            }
        }
    }
}
