import XCTest
@testable import OS1

/// The sidebar asks the server for its own lens, as the web sidebar does,
/// and the response names a sibling's PR list instead of repeating it.
@MainActor
final class SidebarScopeTests: XCTestCase {
    private func sessions(_ json: String) throws -> [Session] {
        try JSONDecoder().decode([Session].self, from: Data(json.utf8))
    }

    func testSidebarPathCarriesTheLens() {
        let path = OS1API.sidebarPath(OS1API.SidebarScope(
            user: "Ada Lovelace",
            person: "me",
            repo: "acme/app",
            showAutoCreated: false,
            selectedSessionId: "os-1"
        ))
        XCTAssertTrue(path.hasPrefix("/api/sessions?"))
        let query = URLComponents(string: "https://example.test\(path)")?.queryItems ?? []
        let values = Dictionary(uniqueKeysWithValues: query.map { ($0.name, $0.value ?? "") })
        XCTAssertEqual(values["archived"], "exclude")
        XCTAssertEqual(values["view"], "sidebar")
        XCTAssertEqual(values["user"], "Ada Lovelace")
        XCTAssertEqual(values["person"], "me")
        XCTAssertEqual(values["repo"], "acme/app")
        XCTAssertEqual(values["autoCreated"], "hide")
        XCTAssertEqual(values["prsFrom"], "1")
        XCTAssertEqual(values["session"], "os-1")
    }

    func testSidebarPathOmitsAnEmptySelection() {
        let path = OS1API.sidebarPath(OS1API.SidebarScope(
            user: "Ada", person: "everyone", repo: "all", showAutoCreated: true
        ))
        XCTAssertFalse(path.contains("session="))
        XCTAssertTrue(path.contains("autoCreated=show"))
    }

    func testSharedPrListsAreRestored() throws {
        let rows = try sessions(
            """
            [{"id":"a","workspaceId":"ws","prs":[{"repo":"acme","branch":"b-1","number":1}]},
             {"id":"b","workspaceId":"ws","prsFrom":"a"},
             {"id":"c","workspaceId":"ws","prs":[{"repo":"acme","branch":"b-2","number":2}]}]
            """
        )
        let restored = OS1API.restoringSharedPrs(rows)
        XCTAssertEqual(restored[1].prs, rows[0].prs)
        XCTAssertNil(restored[1].prsFrom)
        XCTAssertEqual(restored[2].prs?.first?.number, 2)
    }

    func testRowsWithoutSharingPassThrough() throws {
        let rows = try sessions(#"[{"id":"a"},{"id":"b"}]"#)
        XCTAssertEqual(OS1API.restoringSharedPrs(rows), rows)
    }

    /// The per-section index the row menus read answers exactly as the
    /// list walk it replaced, duplicates included.
    func testPositionsMatchStepping() {
        let keys = ["workspace:a", "workspace:b", "workspace:a", "workspace:c"]
        let positions = ActiveOrder.Positions(keys)
        for key in keys + ["workspace:missing"] {
            for step in [-1, 1] {
                XCTAssertEqual(
                    positions.canStep(key, by: step),
                    ActiveOrder.stepping(keys, key: key, by: step) != nil,
                    "\(key) \(step)"
                )
            }
        }
    }

    // MARK: - Row frames

    private func event(_ json: String) -> ServerEvent {
        ServerEvent.parse(Data(json.utf8))
    }

    func testSessionRowFrameCarriesTheRow() {
        guard case .sessionRow(let row) = event(
            #"{"type":"session_row","row":{"id":"os-1","title":"Fix it","isRunning":true}}"#
        ) else { return XCTFail("expected a row") }
        XCTAssertEqual(row.id, "os-1")
        XCTAssertEqual(row.isRunning, true)
    }

    func testRemovedFrameNamesTheRow() {
        guard case .sessionRowRemoved(let id) = event(
            #"{"type":"session_row_removed","id":"os-2"}"#
        ) else { return XCTFail("expected a removal") }
        XCTAssertEqual(id, "os-2")
    }

    /// An unreadable row drops the frame, never the socket's other frames.
    func testUnreadableRowIsIgnored() {
        guard case .ignored = event(#"{"type":"session_row","row":{"title":"no id"}}"#)
        else { return XCTFail("expected ignored") }
    }

    /// A non-string `id` on some other frame must not break that frame.
    func testForeignIdShapeDoesNotBreakOtherFrames() {
        guard case .hello = event(#"{"type":"hello","bootId":"b","id":42}"#)
        else { return XCTFail("expected hello") }
    }

    func testShapeChangesAskForAReread() {
        for type in ["sessions_invalidated", "pins_changed", "workspaces_changed"] {
            guard case .sessionListChanged = event("{\"type\":\"\(type)\"}")
            else { return XCTFail(type) }
        }
    }
}
