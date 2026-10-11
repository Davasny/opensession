import Foundation
import Observation
#if canImport(Network)
import Network
#endif

/// Messages the composer has accepted but the server hasn't acknowledged yet.
///
/// Sending used to be a WebSocket frame and nothing more: `sendDraft` cleared
/// the composer, echoed a bubble, and handed the frame to `OS1Socket.send`,
/// which drops it on the floor when the socket is gone. Offline — or, worse,
/// during the ~40s a backgrounded/wifi-switched socket still reads as
/// connected — that meant the message was simply gone: composer empty, bubble
/// showing, nothing delivered, and the next resync wiping the evidence.
///
/// So every send now lands here first, is written to disk before the composer
/// clears, and stays until the SERVER says it has it. Delivery goes over
/// `POST /api/sessions/:id/prompt` rather than the socket for one reason: it
/// answers. A WS `prompt` frame has no reply — the only hint of success is a
/// content-matched transcript echo a second later — and you cannot build "it
/// was really sent" on that. The reply also says WHERE the message landed
/// (started/steered/queued), which is better than the client's own guess at
/// whether a run was in flight.
///
/// Retries are safe because each item's `id` rides along as the request's
/// `clientId`: the server records the answer per id and replays it instead of
/// delivering twice (src/server/prompt-receipts.ts).
@Observable
@MainActor
final class Outbox {
    static let shared = Outbox()

    /// One accepted-but-undelivered message.
    struct Item: Identifiable, Equatable, Codable, Sendable {
        let id: String
        /// Which server this was typed against. A message must never be
        /// delivered to a different host after a server switch.
        let serverKey: String
        let sessionId: String
        let content: String
        /// Sidecar blob file names — image data URLs live beside the queue
        /// file, not inside it, so state updates rewrite bytes, not megabytes.
        let imageFiles: [String]
        let effort: String?
        let fastMode: Bool?
        /// "standard" | "fast" | "ultrafast". Nil on items queued by builds
        /// that predate it; those replay `fastMode` alone, which the server
        /// reads without downgrading a stored Ultrafast.
        var speed: String? = nil
        /// Staged non-image files (`{name, type, path}` from `/api/upload`).
        /// Nil on items queued by builds that predate file attachments.
        var files: [[String: String]]? = nil
        /// "queue" | "steer" — what to do if a run is in flight on arrival.
        let busyMode: String
        /// Optional origin for a non-composer action. Failure continuations
        /// use the notice id so a durable retry cannot attach to a later error.
        let purpose: String?
        let user: String
        let createdAt: Date
        var attempts: Int
        var lastError: String?
        /// The server refused this message outright (not a connectivity
        /// problem). It waits for the person to retry or delete it, and must
        /// not block the rest of that session's queue forever.
        var failed: Bool
    }

    /// Where a message landed once the server took it — the answer the WS
    /// frame never gave us, and better than the client guessing at run state.
    struct Delivery: Sendable {
        /// "started" | "steered" | "queued" | "handled".
        let status: String
        let message: String
        /// The item's images as data URLs, read back before the blobs were
        /// deleted — the transcript bubble still needs them.
        let images: [String]
    }

    /// Everything still owed to a server, oldest first.
    private(set) var items: [Item] = []

    /// The item currently in flight, if any. Exactly one at a time — a serial
    /// loop is the whole concurrency story here, and it's what keeps a person's
    /// messages in the order they wrote them.
    private(set) var sendingId: String?

    /// Bound: a wedged queue must not grow without limit. Hitting this refuses
    /// the send (loudly) rather than silently dropping an older message —
    /// silent eviction is the very bug this store exists to fix.
    static let maxItems = 200

    // Everything below is machinery, not state a view reads — keeping it off
    // the observation graph means a retry timer can't invalidate a body.
    @ObservationIgnored private var flushTask: Task<Void, Never>?
    @ObservationIgnored private var retryTask: Task<Void, Never>?
    /// Per-session backoff: the whole session waits, so message 2 can never
    /// overtake message 1, but other sessions keep draining.
    @ObservationIgnored private var backoffUntil: [String: Date] = [:]
    @ObservationIgnored private var observers: [String: (Item, Delivery) -> Void] = [:]
    @ObservationIgnored private let directory: URL

    /// How an item reaches the server. Swapped in tests; production posts it.
    @ObservationIgnored
    var transport: @MainActor (Item, [String]) async -> OS1API.PromptDelivery = {
        item, images in
        await OS1API.deliverPrompt(
            sessionId: item.sessionId,
            content: item.content,
            images: images,
            user: item.user,
            busyMode: item.busyMode,
            effort: item.effort,
            fastMode: item.fastMode,
            speed: item.speed,
            files: item.files ?? [],
            clientId: item.id
        )
    }
    #if canImport(Network)
    @ObservationIgnored private var monitor: NWPathMonitor?
    #endif

    /// `directory` and `monitorNetwork` exist for tests, which need their own
    /// scratch store and no live path monitor; the app always uses `.shared`.
    init(directory: URL = Outbox.defaultDirectory, monitorNetwork: Bool = true) {
        self.directory = directory
        try? FileManager.default.createDirectory(
            at: directory, withIntermediateDirectories: true
        )
        items = Self.loadQueue(from: directory.appendingPathComponent("queue.json"))
        // A crash or force-quit mid-POST leaves nothing halfway: the item is
        // simply still here, and the clientId makes the resend a no-op if the
        // server did get it.
        if monitorNetwork { startNetworkMonitor() }
        poke()
    }

    // MARK: - Enqueue

    /// Accept a message for delivery. Returns nil (and keeps nothing) when the
    /// outbox is full, so the caller can put the text back in the composer.
    @discardableResult
    func enqueue(
        sessionId: String,
        content: String,
        images: [String] = [],
        effort: String? = nil,
        fastMode: Bool? = nil,
        speed: String? = nil,
        files stagedFiles: [[String: String]] = [],
        busyMode: String,
        purpose: String? = nil,
        user: String
    ) -> Item? {
        guard items.count < Self.maxItems else { return nil }
        let id = UUID().uuidString
        let files = images.enumerated().compactMap { index, dataURL in
            writeBlob(dataURL, name: "\(id)-\(index)")
        }
        let item = Item(
            id: id,
            serverKey: Self.serverKey(),
            sessionId: sessionId,
            content: content,
            imageFiles: files,
            effort: effort,
            fastMode: fastMode,
            speed: speed,
            files: stagedFiles.isEmpty ? nil : stagedFiles,
            busyMode: busyMode,
            purpose: purpose,
            user: user,
            createdAt: .now,
            attempts: 0,
            lastError: nil,
            failed: false
        )
        items.append(item)
        // Persist BEFORE returning: the composer clears on the strength of
        // this, so the message has to be on disk by the time it does.
        save()
        poke()
        return item
    }

    // MARK: - Reading

    func items(for sessionId: String) -> [Item] {
        items.filter { $0.sessionId == sessionId }
    }

    func pendingCount(for sessionId: String) -> Int {
        items.reduce(0) { $0 + ($1.sessionId == sessionId ? 1 : 0) }
    }

    func item(id: String) -> Item? {
        items.first { $0.id == id }
    }

    /// Image data URLs for a pending item, for the pending bubble's thumbnails.
    func images(for item: Item) -> [String] {
        item.imageFiles.compactMap { readBlob($0) }
    }

    // MARK: - User actions

    /// Drop a message. The only way anything leaves this store unsent.
    func delete(id: String) {
        guard let index = items.firstIndex(where: { $0.id == id }) else { return }
        for file in items[index].imageFiles { deleteBlob(file) }
        items.remove(at: index)
        save()
        poke()
    }

    /// Try a failed message again now.
    func retry(id: String) {
        guard let index = items.firstIndex(where: { $0.id == id }) else { return }
        items[index].failed = false
        items[index].attempts = 0
        items[index].lastError = nil
        backoffUntil[items[index].sessionId] = nil
        save()
        poke()
    }

    // MARK: - Delivery notifications

    /// Live conversations register here so a delivered message can enter the
    /// transcript (or the queue chips) the moment the server takes it. A
    /// session with no observer needs nothing: the next time it's opened, the
    /// server's own transcript carries the message.
    func observe(sessionId: String, _ observer: @escaping (Item, Delivery) -> Void) {
        observers[sessionId] = observer
    }

    func stopObserving(sessionId: String) {
        observers.removeValue(forKey: sessionId)
    }

    // MARK: - Flushing

    /// Nudge the loop: called on enqueue, on connect, on foreground, when the
    /// network path comes back, and after a backoff elapses. Cheap and
    /// idempotent — it starts the loop only if it isn't already running.
    func poke() {
        guard flushTask == nil else { return }
        flushTask = Task { [weak self] in
            await self?.flush()
            self?.flushTask = nil
        }
    }

    /// Run the loop to completion. Tests await this instead of polling; the
    /// app pokes and lets it run.
    func flushNow() async {
        poke()
        while let task = flushTask { await task.value }
    }

    private func flush() async {
        while let item = nextDeliverable() {
            sendingId = item.id
            let outcome = await transport(item, images(for: item))
            sendingId = nil
            // The item may have been deleted by the person mid-flight.
            guard items.contains(where: { $0.id == item.id }) else { continue }
            switch outcome {
            case .delivered(let status, let message):
                backoffUntil[item.sessionId] = nil
                // Read the images back BEFORE the delete drops their blobs —
                // the transcript bubble the observer mints still needs them.
                let delivered = images(for: item)
                delete(id: item.id)
                observers[item.sessionId]?(
                    item,
                    Delivery(status: status, message: message, images: delivered)
                )
            case .rejected(let message):
                markFailed(item.id, message)
            case .missing(let message):
                // A just-created session may not be on disk yet (the server
                // persists it a beat after handing back the id). Give it a
                // window before calling the message undeliverable.
                if Date().timeIntervalSince(item.createdAt) > 120 {
                    markFailed(item.id, message)
                } else {
                    backOff(item, message)
                }
            case .unavailable(let message):
                backOff(item, message)
            }
        }
        scheduleRetry()
    }

    /// The next item that may go out: oldest first, skipping sessions that are
    /// blocked (backing off, failed at the head, or typed against another
    /// server) so one stuck conversation can't hold up the others.
    private func nextDeliverable() -> Item? {
        let now = Date()
        let server = Self.serverKey()
        var blocked = Set<String>()
        for item in items {
            if blocked.contains(item.sessionId) { continue }
            guard item.serverKey == server else {
                blocked.insert(item.sessionId)
                continue
            }
            // A terminally refused item remains visible for Edit/Delete/Retry,
            // but it must not hold every later follow-up in this conversation.
            // Retry keeps its original idempotency key and rejoins the next
            // flush without changing any message that already passed it.
            if item.failed { continue }
            if let until = backoffUntil[item.sessionId], until > now {
                blocked.insert(item.sessionId)
                continue
            }
            return item
        }
        return nil
    }

    private func backOff(_ item: Item, _ message: String) {
        guard let index = items.firstIndex(where: { $0.id == item.id }) else { return }
        items[index].attempts += 1
        items[index].lastError = message
        // 2s, 4s, 8s … capped at a minute, with jitter so several sessions
        // don't all wake at once.
        let delay = min(60, pow(2, Double(min(items[index].attempts, 6))))
        backoffUntil[item.sessionId] = Date().addingTimeInterval(
            delay + Double.random(in: 0...1)
        )
        save()
    }

    private func markFailed(_ id: String, _ message: String) {
        guard let index = items.firstIndex(where: { $0.id == id }) else { return }
        items[index].failed = true
        items[index].lastError = message
        save()
    }

    /// Wake up when the earliest backoff expires — nothing else would restart
    /// the loop for a session that is merely waiting.
    private func scheduleRetry() {
        retryTask?.cancel()
        retryTask = nil
        let waiting = items.filter { !$0.failed && $0.serverKey == Self.serverKey() }
        guard !waiting.isEmpty else { return }
        let due = waiting.compactMap { backoffUntil[$0.sessionId] }.min()
        let delay = max(1, (due?.timeIntervalSinceNow ?? 30))
        retryTask = Task { [weak self] in
            try? await Task.sleep(for: .seconds(delay))
            guard !Task.isCancelled else { return }
            self?.poke()
        }
    }

    private func startNetworkMonitor() {
        #if canImport(Network)
        let monitor = NWPathMonitor()
        monitor.pathUpdateHandler = { path in
            guard path.status == .satisfied else { return }
            // A trigger only, never a gate: "satisfied" says the device has a
            // route, not that this server (often a VPN/tailnet host) answers.
            // The POST result is the only truth about delivery.
            Task { @MainActor [weak self] in
                self?.clearBackoff()
                self?.poke()
            }
        }
        monitor.start(queue: DispatchQueue(label: "dev.tella.os1.outbox.path"))
        self.monitor = monitor
        #endif
    }

    /// Connectivity changed — don't make a waiting message sit out the rest of
    /// a backoff that was measured against the old, dead network.
    func clearBackoff() {
        backoffUntil.removeAll()
    }

    // MARK: - Persistence

    static func serverKey() -> String {
        ServerConfig.shared.baseURL?.absoluteString ?? ""
    }

    // nonisolated: it's read in `init`'s default argument, which Swift
    // evaluates outside the actor.
    nonisolated static var defaultDirectory: URL {
        let base = FileManager.default.urls(
            for: .applicationSupportDirectory, in: .userDomainMask
        ).first ?? URL(fileURLWithPath: NSTemporaryDirectory())
        return base.appendingPathComponent("Outbox", isDirectory: true)
    }

    private var queueURL: URL {
        directory.appendingPathComponent("queue.json")
    }

    private var blobsDirectory: URL {
        let dir = directory.appendingPathComponent("blobs", isDirectory: true)
        try? FileManager.default.createDirectory(
            at: dir, withIntermediateDirectories: true
        )
        return dir
    }

    private func save() {
        guard let data = try? JSONEncoder().encode(items) else { return }
        try? data.write(to: queueURL, options: .atomic)
    }

    private static func loadQueue(from url: URL) -> [Item] {
        guard let data = try? Data(contentsOf: url),
              let loaded = try? JSONDecoder().decode([Item].self, from: data)
        else { return [] }
        return loaded
    }

    /// Store one image beside the queue file. Returns its file name.
    private func writeBlob(_ dataURL: String, name: String) -> String? {
        let file = "\(name).txt"
        do {
            try Data(dataURL.utf8).write(
                to: blobsDirectory.appendingPathComponent(file), options: .atomic
            )
            return file
        } catch {
            return nil
        }
    }

    private func readBlob(_ file: String) -> String? {
        guard let data = try? Data(contentsOf: blobsDirectory.appendingPathComponent(file))
        else { return nil }
        return String(data: data, encoding: .utf8)
    }

    private func deleteBlob(_ file: String) {
        try? FileManager.default.removeItem(
            at: blobsDirectory.appendingPathComponent(file)
        )
    }
}
