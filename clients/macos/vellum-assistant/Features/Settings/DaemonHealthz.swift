import Foundation

/// Health status response from the daemon's `/v1/health` endpoint.
struct DaemonHealthz: Decodable {
    let status: String
    let timestamp: String?
    let version: String?
    let disk: DiskInfo?
    let memory: MemoryInfo?
    let cpu: CpuInfo?

    /// Empty instance used when the health endpoint is unreachable.
    init(status: String = "unavailable", timestamp: String? = nil, version: String? = nil, disk: DiskInfo? = nil, memory: MemoryInfo? = nil, cpu: CpuInfo? = nil) {
        self.status = status
        self.timestamp = timestamp
        self.version = version
        self.disk = disk
        self.memory = memory
        self.cpu = cpu
    }

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
