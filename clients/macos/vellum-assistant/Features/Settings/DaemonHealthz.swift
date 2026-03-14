import Foundation

/// Health status response from the daemon's `/healthz` endpoint.
struct DaemonHealthz: Decodable {
    let status: String
    let timestamp: String?
    let version: String?
    let disk: DiskInfo?
    let memory: MemoryInfo?
    let cpu: CpuInfo?

    struct DiskInfo: Decodable {
        let path: String
        let totalMb: Double
        let usedMb: Double
        let freeMb: Double
    }

    struct MemoryInfo: Decodable {
        let currentMb: Double
        let maxMb: Double
    }

    struct CpuInfo: Decodable {
        let currentPercent: Double
        let maxCores: Int
    }
}
