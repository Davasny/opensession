#if os(iOS)
import SwiftUI

/// One unread session Next can open: the web's `UnreadChat`
/// (lib/unread-chats.ts), built from the sidebar's own rows.
struct UnreadChat: Equatable, Identifiable {
    let id: String
    let title: String
    /// The workspace row it sits under, shown when it differs from `title`.
    let workspace: String
    let repo: String?

    /// What the Next tab names: the workspace, or the session when it has none.
    var label: String { workspace.isEmpty ? title : workspace }
}

/// Where a conversation pushed from the sidebar can go next, installed by the
/// sidebar on the pushed session (`SessionsListView`).
///
/// Equatable on what it shows, not on its closures: the handlers are fresh on
/// every sidebar update, and an environment value that never compares equal
/// would re-evaluate the session view, transcript and all, on every poll.
/// The same reasoning as `OpenPanelAction`.
struct PhoneSessionNavigation: Equatable {
    /// Your unread sessions, in sidebar order starting after the open one.
    var chats: [UnreadChat] = []
    /// The last unread session was just opened: the tab says so briefly.
    var allRead = false
    fileprivate var openChat: ((String) -> Void)?
    fileprivate var archiveAndNext: (() -> Void)?
    fileprivate var newWorkspace: (() -> Void)?

    init() {}

    init(
        chats: [UnreadChat],
        allRead: Bool,
        openChat: @escaping (String) -> Void,
        archiveAndNext: (() -> Void)?,
        newWorkspace: (() -> Void)?
    ) {
        self.chats = chats
        self.allRead = allRead
        self.openChat = openChat
        self.archiveAndNext = archiveAndNext
        self.newWorkspace = newWorkspace
    }

    var canArchive: Bool { archiveAndNext != nil }
    var canOpenNewWorkspace: Bool { newWorkspace != nil }

    func open(_ id: String) { openChat?(id) }
    func archive() { archiveAndNext?() }
    func openNewWorkspace() { newWorkspace?() }

    static func == (lhs: Self, rhs: Self) -> Bool {
        lhs.chats == rhs.chats
            && lhs.allRead == rhs.allRead
            && (lhs.openChat == nil) == (rhs.openChat == nil)
            && (lhs.archiveAndNext == nil) == (rhs.archiveAndNext == nil)
            && (lhs.newWorkspace == nil) == (rhs.newWorkspace == nil)
    }
}

extension EnvironmentValues {
    @Entry var phoneSessionNavigation = PhoneSessionNavigation()
}

/// The session's own actions as one floating glass capsule above the
/// composer, the web phone's action pill: Archive (and open the next unread
/// chat), the ⋯ menu, and New workspace. The navigation bar keeps only the
/// title, as on the web. It steps aside while the keyboard is up.
///
/// The glass is a background SIBLING of the row, not an ancestor of it. A
/// `Menu` whose label sits INSIDE a glass subtree makes the system treat that
/// glass as the menu's morph source, which takes the whole bar off screen for
/// as long as the menu is open. See `SessionInputBar.composer`.
struct SessionActionBar: View {
    var onArchive: (() -> Void)?
    /// The ⋯ menu (`SessionActionsMenu`), sized to `control` by its label.
    var menu: AnyView?
    var onNewWorkspace: (() -> Void)?

    /// Matches the composer's round controls, so the two read as one system.
    static let control: CGFloat = 44

    var body: some View {
        HStack(spacing: 0) {
            if let onArchive {
                iconButton("archivebox", label: "Archive and open next chat", action: onArchive)
            }
            if let menu {
                menu
            }
            if let onNewWorkspace {
                if onArchive != nil || menu != nil {
                    Rectangle()
                        .fill(OS1VisualStyle.border)
                        .frame(width: 1, height: 20)
                        .padding(.horizontal, 2)
                        .accessibilityHidden(true)
                }
                iconButton("plus", label: "New workspace", action: onNewWorkspace)
            }
        }
        .padding(.horizontal, 2)
        .padding(.vertical, 2)
        .fixedSize()
        .clipShape(Capsule())
        .background { Color.clear.glassSurface(in: Capsule()) }
        .frame(maxWidth: .infinity)
        .padding(.bottom, 8)
    }

    private func iconButton(
        _ symbol: String,
        label: String,
        action: @escaping () -> Void
    ) -> some View {
        Button(action: action) {
            Image(systemName: symbol)
                // Weight from the font, never `.resizable()`, so this sits at
                // the same stroke as the composer's controls.
                .font(.system(size: 19))
                .foregroundStyle(OS1VisualStyle.textDim)
                .frame(width: Self.control, height: Self.control)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel(label)
    }
}

/// The web phone's Next tab (`NextUnreadButton`): a compact tab tucked behind
/// the composer's top edge, naming where it goes. Tap opens your next unread
/// session; a long press lists every unread one. When the last one has just
/// been opened it reads "All read" for a moment, then goes.
struct NextUnreadTab: View {
    let navigation: PhoneSessionNavigation
    var cornerRadius: CGFloat = 22

    /// How far the tab tucks under the composer, as the web's `-mb-3.5`.
    static let tuck: CGFloat = 14
    /// The input bar stacks its rows 4pt apart, and the (usually empty)
    /// mention palette sits between this tab and the composer, so two such
    /// gaps separate them. The tab takes both back to sit 44pt above the
    /// composer like the web's (58pt tall, 14 tucked).
    static let barSpacing: CGFloat = 8

    var body: some View {
        if let next = navigation.chats.first {
            Menu {
                Section("Unread sessions · \(navigation.chats.count)") {
                    ForEach(navigation.chats) { chat in
                        Button {
                            Haptics.play(.selection)
                            navigation.open(chat.id)
                        } label: {
                            Text(chat.title)
                            if !chat.workspace.isEmpty, chat.workspace != chat.title {
                                Text(chat.workspace)
                            }
                        }
                    }
                }
            } label: {
                tab {
                    if let repo = next.repo, !repo.isEmpty {
                        RepoTile(name: repo, size: 18)
                            .accessibilityHidden(true)
                    }
                    Text(next.label)
                        .lineLimit(1)
                        .truncationMode(.tail)
                    Image(systemName: "arrow.right")
                        .font(.system(size: 15, weight: .semibold))
                        .accessibilityHidden(true)
                }
                .foregroundStyle(OS1VisualStyle.text)
            } primaryAction: {
                Haptics.play(.selection)
                navigation.open(next.id)
            }
            .menuStyle(.button)
            .buttonStyle(.plain)
            .accessibilityLabel("Next unread: \(next.label)")
            .accessibilityHint("Hold to choose another unread session.")
            .transition(.move(edge: .bottom).combined(with: .opacity))
        } else if navigation.allRead {
            tab {
                Text("All read")
            }
            .foregroundStyle(OS1VisualStyle.textDim)
            .accessibilityAddTraits(.updatesFrequently)
            .transition(.opacity)
        }
    }

    private func tab(@ViewBuilder _ content: () -> some View) -> some View {
        let shape = UnevenRoundedRectangle(
            topLeadingRadius: cornerRadius,
            bottomLeadingRadius: 0,
            bottomTrailingRadius: 0,
            topTrailingRadius: cornerRadius,
            style: .circular
        )
        return HStack(spacing: 8) { content() }
            .font(.subheadline.weight(.medium))
            .padding(.horizontal, 14)
            // Snug: the same 8pt above and below the label in the part that
            // shows. The rest sits under the composer (`tuck`).
            .padding(.top, 8)
            .padding(.bottom, 8 + Self.tuck)
            .fixedSize(horizontal: false, vertical: true)
            .background(OS1VisualStyle.flapSurface, in: shape)
            .overlay { shape.stroke(OS1VisualStyle.border, lineWidth: 0.5) }
            .contentShape(shape)
            // At most most of the bar's width, right-aligned 12pt in from the
            // composer's edge, as on the web.
            .frame(maxWidth: 320, alignment: .trailing)
            .frame(maxWidth: .infinity, alignment: .trailing)
            .padding(.horizontal, 12)
            .padding(.bottom, -(Self.tuck + Self.barSpacing))
    }
}
#endif
