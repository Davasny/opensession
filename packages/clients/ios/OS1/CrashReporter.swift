import Foundation
import MetricKit

/// Sends the app's own crash and hang reports to its server.
///
/// MetricKit hands an app the diagnostics for its previous run on the next
/// launch: a crash's exception, signal, termination reason and call stacks,
/// and the stacks of any long main-thread hang. Without this, a crash on a
/// TestFlight phone left nothing anyone could read short of App Store Connect.
///
/// Each report is written to disk before it is sent, so one that arrives
/// offline (or before sign-in) goes up on a later launch. Reports carry stack
/// frames and device metadata only, never conversation content.
final class CrashReporter: NSObject, MXMetricManagerSubscriber, @unchecked Sendable {
    static let shared = CrashReporter()

    private let queue = DispatchQueue(label: "dev.tella.os1.crash-reporter")
    private let sentKey = "os1.diagnostics.sent"

    private var directory: URL {
        let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
        return base.appendingPathComponent("diagnostics-outbox", isDirectory: true)
    }

    /// Subscribe and pick up anything an earlier launch left behind.
    func install() {
        MXMetricManager.shared.add(self)
        let past = MXMetricManager.shared.pastDiagnosticPayloads
        queue.async { [self] in
            store(past)
            Task { await flush() }
        }
    }

    func didReceive(_ payloads: [MXDiagnosticPayload]) {
        queue.async { [self] in
            store(payloads)
            Task { await flush() }
        }
    }

    // MARK: - Storage

    private func store(_ payloads: [MXDiagnosticPayload]) {
        try? FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        var sent = Set(UserDefaults.standard.stringArray(forKey: sentKey) ?? [])
        for payload in payloads {
            let reports: [(String, MXDiagnostic)] =
                (payload.crashDiagnostics ?? []).map { ("crash", $0) }
                + (payload.hangDiagnostics ?? []).map { ("hang", $0) }
                + (payload.cpuExceptionDiagnostics ?? []).map { ("cpu-exception", $0) }
            for (kind, diagnostic) in reports {
                let json = diagnostic.jsonRepresentation()
                // MetricKit can hand the same past payload over again; its
                // bytes are its identity.
                let key = Self.digest(json)
                guard !sent.contains(key) else { continue }
                sent.insert(key)
                var body: [String: Any] = [
                    "kind": kind,
                    "platform": Self.platform,
                    "version": Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "",
                    "build": Bundle.main.object(forInfoDictionaryKey: "CFBundleVersion") as? String ?? "",
                    "os": ProcessInfo.processInfo.operatingSystemVersionString,
                    "periodStart": ISO8601DateFormatter().string(from: payload.timeStampBegin),
                    "periodEnd": ISO8601DateFormatter().string(from: payload.timeStampEnd),
                ]
                body["diagnostic"] = (try? JSONSerialization.jsonObject(with: json)) ?? [:]
                if let data = try? JSONSerialization.data(withJSONObject: body) {
                    try? data.write(to: directory.appendingPathComponent("\(key).json"), options: .atomic)
                }
            }
        }
        UserDefaults.standard.set(Array(sent.suffix(300)), forKey: sentKey)
    }

    /// Send every stored report; each is deleted once the server has it.
    @MainActor
    func flush() async {
        guard ServerConfig.shared.isConfigured else { return }
        let files = (try? FileManager.default.contentsOfDirectory(
            at: directory, includingPropertiesForKeys: nil
        )) ?? []
        for file in files where file.pathExtension == "json" {
            guard let data = try? Data(contentsOf: file),
                  let body = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
            else {
                try? FileManager.default.removeItem(at: file)
                continue
            }
            do {
                try await OS1API.sendClientDiagnostic(body)
                try? FileManager.default.removeItem(at: file)
            } catch {
                return
            }
        }
    }

    private static var platform: String {
        #if os(iOS)
        "ios"
        #else
        "macos"
        #endif
    }

    /// A short, stable name for a report: FNV-1a over its bytes.
    private static func digest(_ data: Data) -> String {
        var hash: UInt64 = 0xcbf2_9ce4_8422_2325
        for byte in data {
            hash ^= UInt64(byte)
            hash = hash &* 0x0000_0100_0000_01b3
        }
        return String(hash, radix: 16)
    }
}
