import Foundation
#if os(iOS)
import UIKit
#else
import AppKit
#endif

/// Switching Tailscale accounts when switching organizations.
///
/// iOS gives an app no way to see or change another app's VPN, so the switch
/// itself always happens in Tailscale. This decides when to ask for it and
/// how: a Shortcuts shortcut the person set up (which switches and opens this
/// app again), or Tailscale itself.
@MainActor
enum TailscaleHandoff {
    private static let reachedDefaultsKey = "os1.lastReachedTailnet"

    /// Tailscale's App Store id, the fallback when its own URL doesn't open.
    nonisolated static let appStoreURL = URL(string: "https://apps.apple.com/app/tailscale/id1470499037")!
    nonisolated static let appURL = URL(string: "tailscale://")!

    /// What identifies an account's tailnet: the name the person gave it, or
    /// the tailnet part of a MagicDNS server name (`host.tail1234.ts.net`).
    nonisolated static func tailnetKey(for account: ServerAccount) -> String? {
        if let named = account.tailscaleAccount?.trimmingCharacters(in: .whitespaces),
           !named.isEmpty {
            return named.lowercased()
        }
        return magicDNSTailnet(account.url)
    }

    nonisolated static func magicDNSTailnet(_ raw: String) -> String? {
        let candidate = raw.contains("://") ? raw : "https://\(raw)"
        guard let host = URL(string: candidate)?.host()?.lowercased(),
              Reachability.isTailnetHostname(host)
        else { return nil }
        let labels = host.split(separator: ".")
        guard labels.count >= 4 else { return nil }
        return labels.dropFirst().joined(separator: ".")
    }

    /// The name to show in "Switch Tailscale to …".
    nonisolated static func displayName(for account: ServerAccount) -> String? {
        if let named = account.tailscaleAccount?.trimmingCharacters(in: .whitespaces),
           !named.isEmpty {
            return named
        }
        return magicDNSTailnet(account.url)
    }

    /// The tailnet this device last reached a server on. A successful load
    /// proves which account Tailscale is on; nothing else can tell us.
    static var lastReachedTailnet: String? {
        UserDefaults.standard.string(forKey: reachedDefaultsKey)
    }

    static func noteReached(_ account: ServerAccount) {
        guard let key = tailnetKey(for: account) else { return }
        UserDefaults.standard.set(key, forKey: reachedDefaultsKey)
    }

    /// True when `account` needs a different Tailscale account than the one
    /// this device was last on.
    static func needsSwitch(to account: ServerAccount) -> Bool {
        guard let wanted = tailnetKey(for: account), let current = lastReachedTailnet else {
            return false
        }
        return wanted != current
    }

    /// The shortcut the app offers to add: it takes an account name as input
    /// and runs Tailscale's own Switch Account action with it. Signing a
    /// shortcut needs an iCloud account, so it is shared as an iCloud link
    /// rather than shipped in the bundle. Nil hides the Add button.
    nonisolated static let sharedShortcutName = "Switch Tailscale Account"
    nonisolated static let sharedShortcutLink: URL? = nil

    /// Where Shortcuts sends you when the shortcut finishes. Only the iOS
    /// target registers it; the Electron shell owns `os://` and `os1://`
    /// on the Mac.
    nonisolated static let returnScheme = "os1-native"

    /// The person's shortcut, run through the Shortcuts app with the
    /// account name as its input, returning here when it finishes.
    nonisolated static func shortcutURL(for account: ServerAccount) -> URL? {
        guard let name = account.tailscaleShortcut?.trimmingCharacters(in: .whitespaces),
              !name.isEmpty
        else { return nil }
        var components = URLComponents()
        components.scheme = "shortcuts"
        var items = [URLQueryItem(name: "name", value: name)]
        if let target = account.tailscaleAccount?.trimmingCharacters(in: .whitespaces),
           !target.isEmpty {
            items += [
                URLQueryItem(name: "input", value: "text"),
                URLQueryItem(name: "text", value: target),
            ]
        }
        #if os(iOS)
        components.host = "x-callback-url"
        components.path = "/run-shortcut"
        items.append(URLQueryItem(name: "x-success", value: "\(returnScheme)://tailscale"))
        #else
        components.host = "run-shortcut"
        #endif
        components.queryItems = items
        return components.url
    }

    /// Whether `url` is Shortcuts handing control back after a switch.
    nonisolated static func isReturn(_ url: URL) -> Bool {
        url.scheme?.lowercased() == returnScheme
    }

    /// Open Apple's Add Shortcut screen for the shared shortcut.
    static func addSharedShortcut() {
        guard let link = sharedShortcutLink else { return }
        launch(link) { _ in }
    }

    /// Where the switch button goes: the shortcut when there is one, else
    /// Tailscale.
    nonisolated static func switchURL(for account: ServerAccount) -> URL {
        shortcutURL(for: account) ?? appURL
    }

    /// Send the person to make the switch: their shortcut, else Tailscale,
    /// else Tailscale's App Store page when it isn't installed.
    static func open(for account: ServerAccount) {
        let primary = switchURL(for: account)
        launch(primary) { opened in
            if !opened, primary != appStoreURL { launch(appStoreURL) { _ in } }
        }
    }

    /// Run the shortcut on an organization switch that needs another
    /// Tailscale account. Without a shortcut nothing happens here: the list
    /// says what to do once it can't reach the server.
    static func switchIfNeeded(to account: ServerAccount) {
        guard needsSwitch(to: account), let url = shortcutURL(for: account) else { return }
        launch(url) { _ in }
    }

    private static func launch(_ url: URL, completion: @escaping @MainActor (Bool) -> Void) {
        #if os(iOS)
        UIApplication.shared.open(url) { opened in
            Task { @MainActor in completion(opened) }
        }
        #else
        completion(NSWorkspace.shared.open(url))
        #endif
    }
}
