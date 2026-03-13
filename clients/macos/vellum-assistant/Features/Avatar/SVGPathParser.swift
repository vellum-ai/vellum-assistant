import CoreGraphics

/// Parses an SVG path `d` attribute string into a `CGPath`.
///
/// Supports the following commands (absolute and relative):
/// - `M/m` (moveTo) — with implicit lineTo for subsequent coordinate pairs
/// - `L/l` (lineTo)
/// - `H/h` (horizontal lineTo)
/// - `V/v` (vertical lineTo)
/// - `C/c` (cubic bezier curveTo)
/// - `Z/z` (closePath)
///
/// Handles edge cases per the SVG spec:
/// - Negative numbers without whitespace separator (e.g., `C1.5-2.3`)
/// - Adjacent decimal numbers (e.g., `0.5.3` parsed as `0.5` and `0.3`)
/// - Scientific notation (e.g., `1e-4`)
/// - Implicit repeated commands after the initial coordinate group
func parseSVGPath(_ d: String) -> CGPath {
    return parseSVGPathToEditable(d).toCGPath()
}

/// Parses an SVG path `d` attribute string into an `EditablePath`, preserving
/// individual path elements for programmatic manipulation (animations, morphing).
///
/// Uses the same tokenizer and coordinate resolution logic as `parseSVGPath`,
/// but builds an `EditablePath` instead of a `CGPath` directly.
func parseSVGPathToEditable(_ d: String) -> EditablePath {
    let tokens = tokenize(d)
    return buildEditablePath(from: tokens)
}

// MARK: - Token Types

private enum Token {
    case command(Character)
    case number(CGFloat)
}

// MARK: - Tokenizer

/// Scans the SVG path `d` string character by character, extracting command
/// letters and floating-point numbers. Handles tricky cases where numbers
/// run together without whitespace (e.g., `C1.5-2.3` or `0.5.3`).
private func tokenize(_ d: String) -> [Token] {
    var tokens: [Token] = []
    let chars = Array(d)
    var i = 0

    while i < chars.count {
        let ch = chars[i]

        // Skip whitespace and commas (they are separators)
        if ch == " " || ch == "\t" || ch == "\n" || ch == "\r" || ch == "," {
            i += 1
            continue
        }

        // Command letters
        if isCommandLetter(ch) {
            tokens.append(.command(ch))
            i += 1
            continue
        }

        // Numbers (including negative, decimal, scientific notation)
        if ch == "-" || ch == "+" || ch == "." || ch.isNumber {
            let (number, newIndex) = scanNumber(chars, from: i)
            if let number = number {
                tokens.append(.number(CGFloat(number)))
            }
            i = newIndex
            continue
        }

        // Skip any unrecognized character
        i += 1
    }

    return tokens
}

private func isCommandLetter(_ ch: Character) -> Bool {
    switch ch {
    case "M", "m", "L", "l", "H", "h", "V", "v", "C", "c", "Z", "z":
        return true
    default:
        return false
    }
}

/// Scans a floating-point number starting at `from`, returning the parsed
/// value and the index past the last consumed character.
///
/// Handles:
/// - Leading sign (`-`, `+`)
/// - Integer and fractional parts
/// - Scientific notation (`e`, `E` followed by optional sign and digits)
/// - Adjacent decimals: `0.5.3` is parsed as `0.5` (stops before second `.`)
private func scanNumber(_ chars: [Character], from start: Int) -> (Double?, Int) {
    var i = start
    var hasDigits = false
    var hasDot = false

    // Optional leading sign
    if i < chars.count && (chars[i] == "-" || chars[i] == "+") {
        i += 1
    }

    // Integer part
    while i < chars.count && chars[i].isNumber {
        hasDigits = true
        i += 1
    }

    // Fractional part
    if i < chars.count && chars[i] == "." {
        hasDot = true
        i += 1
        while i < chars.count && chars[i].isNumber {
            hasDigits = true
            i += 1
        }
    }

    guard hasDigits else {
        // No valid number found (e.g., lone `.` or sign with no digits)
        return (nil, start + 1)
    }

    // Scientific notation
    if i < chars.count && (chars[i] == "e" || chars[i] == "E") {
        let eIndex = i
        i += 1
        if i < chars.count && (chars[i] == "-" || chars[i] == "+") {
            i += 1
        }
        var hasExpDigits = false
        while i < chars.count && chars[i].isNumber {
            hasExpDigits = true
            i += 1
        }
        if !hasExpDigits {
            // Invalid exponent — backtrack to before 'e'
            i = eIndex
        }
    }

    let numberString = String(chars[start..<i])
    let value = Double(numberString)
    return (value, i)
}

// MARK: - Path Builder

/// Processes the token stream and builds an EditablePath with individual path elements.
private func buildEditablePath(from tokens: [Token]) -> EditablePath {
    var elements: [EditablePath.PathElement] = []
    var currentPoint = CGPoint.zero
    var startPoint = CGPoint.zero
    var currentCommand: Character = "M"
    var isRelative = false
    var i = 0

    while i < tokens.count {
        // Check if the current token is a command
        if case .command(let cmd) = tokens[i] {
            currentCommand = cmd.uppercased().first!
            isRelative = cmd.isLowercase
            i += 1

            // Z/z takes no arguments
            if currentCommand == "Z" {
                elements.append(.close)
                currentPoint = startPoint
                continue
            }
        }

        // Consume arguments for the current command
        switch currentCommand {
        case "M":
            guard let (x, y, newI) = consumeCoordinatePair(tokens, from: i) else { break }
            let point = resolvePoint(x: x, y: y, relative: isRelative, current: currentPoint)
            elements.append(.moveTo(point))
            currentPoint = point
            startPoint = point
            i = newI
            // Per SVG spec: subsequent coordinate pairs after M are treated as implicit L
            currentCommand = "L"
            continue

        case "L":
            guard let (x, y, newI) = consumeCoordinatePair(tokens, from: i) else { break }
            let point = resolvePoint(x: x, y: y, relative: isRelative, current: currentPoint)
            elements.append(.lineTo(point))
            currentPoint = point
            i = newI
            continue

        case "H":
            guard let (x, newI) = consumeNumber(tokens, from: i) else { break }
            let absX = isRelative ? currentPoint.x + x : x
            let point = CGPoint(x: absX, y: currentPoint.y)
            elements.append(.lineTo(point))
            currentPoint = point
            i = newI
            continue

        case "V":
            guard let (y, newI) = consumeNumber(tokens, from: i) else { break }
            let absY = isRelative ? currentPoint.y + y : y
            let point = CGPoint(x: currentPoint.x, y: absY)
            elements.append(.lineTo(point))
            currentPoint = point
            i = newI
            continue

        case "C":
            guard let (x1, y1, newI1) = consumeCoordinatePair(tokens, from: i),
                  let (x2, y2, newI2) = consumeCoordinatePair(tokens, from: newI1),
                  let (x, y, newI3) = consumeCoordinatePair(tokens, from: newI2) else { break }
            let control1 = resolvePoint(x: x1, y: y1, relative: isRelative, current: currentPoint)
            let control2 = resolvePoint(x: x2, y: y2, relative: isRelative, current: currentPoint)
            let endPoint = resolvePoint(x: x, y: y, relative: isRelative, current: currentPoint)
            elements.append(.curveTo(to: endPoint, control1: control1, control2: control2))
            currentPoint = endPoint
            i = newI3
            continue

        default:
            break
        }

        // If we reach here, we couldn't consume arguments for the current command.
        // Advance past any stray token to avoid an infinite loop.
        i += 1
    }

    return EditablePath(elements: elements)
}

// MARK: - Helpers

/// Resolves absolute or relative coordinates to an absolute point.
private func resolvePoint(x: CGFloat, y: CGFloat, relative: Bool, current: CGPoint) -> CGPoint {
    if relative {
        return CGPoint(x: current.x + x, y: current.y + y)
    }
    return CGPoint(x: x, y: y)
}

/// Consumes two consecutive number tokens as a coordinate pair.
private func consumeCoordinatePair(_ tokens: [Token], from index: Int) -> (CGFloat, CGFloat, Int)? {
    guard index < tokens.count,
          case .number(let x) = tokens[index],
          index + 1 < tokens.count,
          case .number(let y) = tokens[index + 1] else {
        return nil
    }
    return (x, y, index + 2)
}

/// Consumes a single number token.
private func consumeNumber(_ tokens: [Token], from index: Int) -> (CGFloat, Int)? {
    guard index < tokens.count,
          case .number(let value) = tokens[index] else {
        return nil
    }
    return (value, index + 1)
}
