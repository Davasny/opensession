import Foundation

/// Live sidebar rows over the app-wide socket, the way the web sidebar keeps
/// its list current.
///
/// The list used to re-read itself every five seconds. The server caches a
/// scoped sidebar answer for exactly that long, so every poll rebuilt the
/// projection (hundreds of milliseconds of server work per poll, per
/// device). Instead the socket subscribes with the list's own query
/// (`sessions_subscribe`), and the server pushes each changed row, already
/// scoped to that lens. The list applies rows in place and re-reads only on
/// reconnect, on a shape change rows don't carry, and on a slow fallback
/// clock that repairs a missed frame.
@MainActor
final class SessionRowFeed {
    static let shared = SessionRowFeed()

    /// Rows changed and removed since the last flush, coalesced.
    typealias RowsHandler = (_ upserts: [Session], _ removals: Set<String>) -> Void

    /// Whether row frames are arriving for the current query. Off, the list
    /// falls back to polling at its old pace.
    private(set) var isLive = false

    var onRows: RowsHandler?
    /// Re-read the whole list: the socket (re)connected, or the list's shape
    /// changed in a way a row can't say.
    var onResync: (() -> Void)?

    private var query: String?
    private weak var socket: OS1Socket?
    private var upserts: [String: Session] = [:]
    private var removals: Set<String> = []
    private var flushTask: Task<Void, Never>?
    private var resyncTask: Task<Void, Never>?

    /// The query part of the list request (`archived=exclude&view=sidebar…`).
    func setQuery(_ next: String) {
        guard next != query else { return }
        query = next
        if let socket {
            socket.subscribeSessions(query: next)
            isLive = true
        }
    }

    /// The active account's socket finished its handshake.
    func attach(_ socket: OS1Socket) {
        self.socket = socket
        if let query {
            socket.subscribeSessions(query: query)
            isLive = true
        }
        // Nothing replays what changed while no socket was listening.
        resync()
    }

    func detach() {
        socket = nil
        isLive = false
    }

    func isAttached(to socket: OS1Socket?) -> Bool {
        socket != nil && socket === self.socket
    }

    func receive(_ row: Session) {
        removals.remove(row.id)
        upserts[row.id] = row
        scheduleFlush()
    }

    func receiveRemoved(_ id: String) {
        upserts[id] = nil
        removals.insert(id)
        scheduleFlush()
    }

    /// Coalesced, because a workspace broadcast can arrive several times in
    /// one write burst.
    func resync() {
        resyncTask?.cancel()
        resyncTask = Task { [weak self] in
            try? await Task.sleep(for: .milliseconds(300))
            guard let self, !Task.isCancelled else { return }
            self.resyncTask = nil
            self.onResync?()
        }
    }

    /// The server already coalesces row writes into 250 ms windows; this
    /// folds a window's frames into one regroup of the list.
    private func scheduleFlush() {
        guard flushTask == nil else { return }
        flushTask = Task { [weak self] in
            try? await Task.sleep(for: .milliseconds(100))
            guard let self else { return }
            self.flushTask = nil
            let rows = Array(self.upserts.values)
            let removed = self.removals
            self.upserts = [:]
            self.removals = []
            guard !rows.isEmpty || !removed.isEmpty else { return }
            self.onRows?(rows, removed)
        }
    }
}
