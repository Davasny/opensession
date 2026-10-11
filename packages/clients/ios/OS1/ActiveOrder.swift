import Foundation
import SwiftUI

/// The Active section's manual order, shared with the web sidebar's
/// `active-order` ui-pref (src/frontend/lib/active-order.ts).
///
/// Rows start in creation order, newest first, and stay put. Moving a row pins
/// that section's rows into the order you left them in. Rows the saved order
/// does not name yet (new work) still arrive on top, so a fresh workspace is
/// never buried under an order made before it existed.
///
/// Keys are the web's row keys (`SidebarRowKeys.sharedRowKey`), so an order
/// dragged in the browser holds here, and keys this device has no row for
/// (another repo's rows, a filter, a row hidden here) are carried through
/// every write untouched.
enum ActiveOrder {
    static let prefKey = "active-order"
    static let storageKey = "os1.sidebar.activeOrder"
    /// Under the server's 16,384-character cap for long ui-pref values.
    static let maxChars = 16_000

    /// Trimmed, non-empty, de-duplicated keys that fit `maxChars` as JSON,
    /// kept from the front. Anything that is not a list of strings is empty.
    static func normalize(_ keys: [String]) -> [String] {
        var seen = Set<String>()
        var order: [String] = []
        var chars = 2
        for raw in keys {
            let key = raw.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !key.isEmpty, seen.insert(key).inserted else { continue }
            chars += encodedLength(key) + (order.isEmpty ? 0 : 1)
            if chars > maxChars { break }
            order.append(key)
        }
        return order
    }

    static func decode(_ json: String?) -> [String] {
        guard let json, let data = json.data(using: .utf8),
              let values = try? JSONSerialization.jsonObject(with: data) as? [Any]
        else { return [] }
        return normalize(values.compactMap { $0 as? String })
    }

    static func encode(_ order: [String]) -> String {
        guard let data = try? JSONEncoder().encode(normalize(order)) else { return "[]" }
        return String(decoding: data, as: UTF8.self)
    }

    /// The validated value `NativePreferences` mirrors, or nil when the server
    /// sent nothing usable.
    static func validated(_ json: String?) -> String? {
        guard let json, let data = json.data(using: .utf8),
              (try? JSONSerialization.jsonObject(with: data)) is [Any]
        else { return nil }
        return encode(decode(json))
    }

    /// Unplaced rows first (newest first), then placed rows in saved order.
    /// Rows sharing a key (Mac session rows of one workspace) keep their
    /// creation order among themselves.
    static func sort(
        _ rows: [SidebarWorkspace],
        order: [String],
        key: (SidebarWorkspace) -> String = SidebarRowKeys.sharedRowKey
    ) -> [SidebarWorkspace] {
        let index = Dictionary(
            order.enumerated().map { ($1, $0) },
            uniquingKeysWith: { first, _ in first }
        )
        let byCreation = WorkspaceSnooze.sortActive(rows)
        let unplaced = byCreation.filter { index[key($0)] == nil }
        var placed: [(row: SidebarWorkspace, slot: Int, created: Int)] = []
        for (created, row) in byCreation.enumerated() {
            if let slot = index[key(row)] {
                placed.append((row, slot, created))
            }
        }
        placed.sort { left, right in
            left.slot == right.slot ? left.created < right.created : left.slot < right.slot
        }
        return unplaced + placed.map(\.row)
    }

    /// The saved order after a move: the section's keys lead, and every other
    /// saved key keeps its relative place behind them. Sections never share
    /// rows, so this cannot move a row in any other section.
    static func place(saved: [String], section: [String]) -> [String] {
        var seen = Set<String>()
        let lead = section.filter { seen.insert($0).inserted }
        return normalize(lead + saved.filter { !seen.contains($0) })
    }

    /// A section's keys after `List.onMove`, de-duplicated so the Mac's
    /// several rows for one workspace move as one.
    static func moving(
        _ keys: [String],
        from source: IndexSet,
        to destination: Int
    ) -> [String] {
        var next = keys
        next.move(fromOffsets: source, toOffset: destination)
        var seen = Set<String>()
        return next.filter { seen.insert($0).inserted }
    }

    /// A section's keys with one row stepped up (`by: -1`) or down (`by: 1`).
    /// Nil when it is already at that end.
    /// One section's row keys with each key's place, built once per section
    /// so every row's menu can ask "can this move?" without walking the
    /// section again (asking `stepping` per row made the list quadratic).
    struct Positions: Equatable {
        let keys: [String]
        private let index: [String: Int]
        private let count: Int

        init(_ keys: [String]) {
            self.keys = keys
            var index: [String: Int] = [:]
            for key in keys where index[key] == nil { index[key] = index.count }
            self.index = index
            count = index.count
        }

        /// Same answer as `stepping(keys, key:, by:) != nil`.
        func canStep(_ key: String, by step: Int) -> Bool {
            guard let position = index[key] else { return false }
            return (0..<count).contains(position + step)
        }
    }

    static func stepping(_ keys: [String], key: String, by step: Int) -> [String]? {
        var unique: [String] = []
        var seen = Set<String>()
        for item in keys where seen.insert(item).inserted { unique.append(item) }
        guard let index = unique.firstIndex(of: key) else { return nil }
        let target = index + step
        guard unique.indices.contains(target) else { return nil }
        unique.swapAt(index, target)
        return unique
    }

    private static func encodedLength(_ key: String) -> Int {
        guard let data = try? JSONEncoder().encode(key) else { return key.utf8.count + 2 }
        return String(decoding: data, as: UTF8.self).count
    }
}

/// Writes the Active order: the local mirror moves on the gesture, and the
/// ui-pref PUT confirms it. Periodic hydration is held off while the write is
/// in flight so an older server value cannot repaint the move backward.
@MainActor
enum ActiveOrderWriter {
    static func save(_ order: [String]) {
        let json = ActiveOrder.encode(order)
        let defaults = UserDefaults.standard
        guard defaults.string(forKey: ActiveOrder.storageKey) != json else { return }
        defaults.set(json, forKey: ActiveOrder.storageKey)
        let requestContext = NativePreferences.context()
        guard ServerConfig.shared.isConfigured else { return }
        NativePreferences.beginLocalWrite()
        Task {
            defer { NativePreferences.endLocalWrite() }
            guard var confirmed = try? await SettingsAPI.updateUiPrefs(
                user: requestContext.user,
                prefs: [ActiveOrder.prefKey: json]
            ) else { return }
            // A newer move made while this one was in flight wins locally.
            let latest = defaults.string(forKey: ActiveOrder.storageKey) ?? json
            confirmed[ActiveOrder.prefKey] = latest
            _ = NativePreferences.apply(confirmed, for: requestContext)
        }
    }
}
