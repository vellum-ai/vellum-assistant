import SwiftUI

struct TypewriterText: View {
    let fullText: String
    var speed: TimeInterval = 0.05
    var font: Font = VellumFont.onboardingTitle
    var onComplete: (() -> Void)? = nil

    @State private var displayedText = ""
    @State private var timer: Timer?
    @State private var charIndex = 0

    var body: some View {
        Text(displayedText)
            .font(font)
            .foregroundColor(VellumTheme.textPrimary)
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

#Preview {
    ZStack {
        VellumTheme.background
        TypewriterText(fullText: "Hello, world.")
    }
    .frame(width: 400, height: 200)
}
