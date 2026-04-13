import Foundation

/// Encodes raw PCM audio samples into a valid WAV file payload.
///
/// This utility handles the mechanical WAV serialization so that callers
/// (macOS push-to-talk, iOS input bar, macOS voice mode) do not need to
/// duplicate ad hoc audio encoding logic. It only serializes audio data —
/// transport concerns belong to ``STTClient``.
///
/// WAV format reference: http://soundfile.sapp.org/doc/WaveFormat/
public enum AudioWavEncoder {

    // MARK: - Configuration

    /// Parameters describing the PCM audio format to encode.
    public struct Format: Sendable {
        /// Sample rate in Hz (e.g. 16000, 44100, 48000).
        public let sampleRate: Int
        /// Number of audio channels (1 = mono, 2 = stereo).
        public let channels: Int
        /// Bits per sample (typically 16).
        public let bitsPerSample: Int

        public init(sampleRate: Int, channels: Int, bitsPerSample: Int) {
            self.sampleRate = sampleRate
            self.channels = channels
            self.bitsPerSample = bitsPerSample
        }

        /// Commonly used format: 16 kHz mono 16-bit, suitable for speech recognition.
        public static let speech16kHz = Format(sampleRate: 16000, channels: 1, bitsPerSample: 16)

        /// Commonly used format: 44.1 kHz mono 16-bit.
        public static let cd44kHzMono = Format(sampleRate: 44100, channels: 1, bitsPerSample: 16)
    }

    /// The size of a standard WAV header (RIFF + fmt + data chunk headers).
    public static let headerSize = 44

    // MARK: - Public API

    /// Encodes raw PCM sample data into a complete WAV file.
    ///
    /// - Parameters:
    ///   - pcmData: Raw PCM audio samples in little-endian byte order.
    ///   - format: The audio format describing sample rate, channels, and bit depth.
    /// - Returns: A `Data` value containing a valid WAV file (header + payload).
    public static func encode(pcmData: Data, format: Format) -> Data {
        var data = Data()
        data.reserveCapacity(headerSize + pcmData.count)
        writeHeader(to: &data, pcmDataSize: pcmData.count, format: format)
        data.append(pcmData)
        return data
    }

    /// Encodes raw PCM sample data provided as an `UnsafeBufferPointer<Int16>`
    /// (common when working with `AVAudioPCMBuffer.int16ChannelData`).
    ///
    /// - Parameters:
    ///   - samples: Pointer to interleaved 16-bit PCM samples.
    ///   - format: The audio format describing sample rate, channels, and bit depth.
    /// - Returns: A `Data` value containing a valid WAV file (header + payload).
    public static func encode(samples: UnsafeBufferPointer<Int16>, format: Format) -> Data {
        precondition(format.bitsPerSample == 16, "encode(samples:format:) only supports 16-bit samples")
        let pcmData = Data(buffer: samples)
        return encode(pcmData: pcmData, format: format)
    }

    // MARK: - Header Construction

    /// Writes a 44-byte WAV header into the given `Data`.
    ///
    /// Layout (all multi-byte values are little-endian unless noted):
    /// ```
    /// Offset  Size  Description
    ///   0       4   "RIFF" (big-endian ASCII)
    ///   4       4   File size minus 8 (total - RIFF header)
    ///   8       4   "WAVE" (big-endian ASCII)
    ///  12       4   "fmt " (big-endian ASCII)
    ///  16       4   Subchunk1 size (16 for PCM)
    ///  20       2   Audio format (1 = PCM)
    ///  22       2   Number of channels
    ///  24       4   Sample rate
    ///  28       4   Byte rate (sampleRate * channels * bitsPerSample / 8)
    ///  32       2   Block align (channels * bitsPerSample / 8)
    ///  34       2   Bits per sample
    ///  36       4   "data" (big-endian ASCII)
    ///  40       4   Subchunk2 size (PCM data byte count)
    /// ```
    private static func writeHeader(to data: inout Data, pcmDataSize: Int, format: Format) {
        let byteRate = format.sampleRate * format.channels * format.bitsPerSample / 8
        let blockAlign = format.channels * format.bitsPerSample / 8
        let fileSize = UInt32(36 + pcmDataSize) // Total file size minus 8 for RIFF header

        // RIFF chunk
        data.append(contentsOf: [0x52, 0x49, 0x46, 0x46]) // "RIFF"
        appendUInt32LE(&data, fileSize)
        data.append(contentsOf: [0x57, 0x41, 0x56, 0x45]) // "WAVE"

        // fmt subchunk
        data.append(contentsOf: [0x66, 0x6D, 0x74, 0x20]) // "fmt "
        appendUInt32LE(&data, 16)                           // Subchunk1 size (PCM)
        appendUInt16LE(&data, 1)                            // Audio format (PCM)
        appendUInt16LE(&data, UInt16(format.channels))
        appendUInt32LE(&data, UInt32(format.sampleRate))
        appendUInt32LE(&data, UInt32(byteRate))
        appendUInt16LE(&data, UInt16(blockAlign))
        appendUInt16LE(&data, UInt16(format.bitsPerSample))

        // data subchunk
        data.append(contentsOf: [0x64, 0x61, 0x74, 0x61]) // "data"
        appendUInt32LE(&data, UInt32(pcmDataSize))
    }

    // MARK: - Little-Endian Helpers

    private static func appendUInt16LE(_ data: inout Data, _ value: UInt16) {
        withUnsafeBytes(of: value.littleEndian) { data.append(contentsOf: $0) }
    }

    private static func appendUInt32LE(_ data: inout Data, _ value: UInt32) {
        withUnsafeBytes(of: value.littleEndian) { data.append(contentsOf: $0) }
    }
}
