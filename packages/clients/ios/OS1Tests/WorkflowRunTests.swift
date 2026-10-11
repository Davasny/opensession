import XCTest
@testable import OS1

final class WorkflowRunTests: XCTestCase {
    private func decodeRuns(_ json: String) throws -> [WorkflowRun] {
        try JSONDecoder().decode(WorkflowRunsResponse.self, from: Data(json.utf8)).runs
    }

    /// The shape the live server answers with, fields and all — including the
    /// ones this app deliberately does not decode (promptPreview, tokens,
    /// cached, structured, logs, totals, cwd), which must pass through
    /// without upsetting anything.
    func testDecodesTheLiveRunShape() throws {
        let runs = try decodeRuns("""
        {"runs":[{
          "runId":"wf-019ff9c6-5d7a-7000-8bfe-c5a76e9eb95b",
          "sessionId":"os-019ff9b4-d09f-7001-9396-fd9a8ccbdea2",
          "name":"morning-support-digest",
          "status":"done",
          "phases":["Classify","Synthesize"],
          "currentPhase":"Synthesize",
          "cwd":"/home/ubuntu/projects/opensession",
          "user":"Michiel",
          "logs":[],
          "totals":{"agents":6,"tokensIn":116737,"tokensOut":1682},
          "startedAt":"2026-08-13T06:19:02.000Z",
          "endedAt":"2026-08-13T06:24:02.000Z",
          "agents":[
            {"seq":0,"label":"classify 1/5","phase":"Classify","status":"done",
             "model":"pi/anthropic/claude-haiku-4-5",
             "promptPreview":"Classify EVERY support ticket below…",
             "resultPreview":"[{\\"id\\":\\"th_01\\"}]",
             "cached":false,"structured":true,
             "tokens":{"input":23000,"output":300},
             "startedAt":"2026-08-13T06:19:03.000Z",
             "endedAt":"2026-08-13T06:19:48.000Z",
             "engineSessionId":"ses_abc"},
            {"seq":5,"label":"synthesize","phase":"Synthesize","status":"done",
             "startedAt":"2026-08-13T06:23:00.000Z",
             "endedAt":"2026-08-13T06:24:02.000Z",
             "engineSessionId":"ses_def"}
          ]}]}
        """)
        XCTAssertEqual(runs.count, 1)
        let run = try XCTUnwrap(runs.first)
        XCTAssertEqual(run.name, "morning-support-digest")
        XCTAssertEqual(run.status, .done)
        XCTAssertEqual(run.agents.count, 2)
        XCTAssertFalse(run.canCancel)
        XCTAssertEqual(run.progressLine, "2 agents")

        let first = try XCTUnwrap(run.agents.first)
        XCTAssertEqual(first.label, "classify 1/5")
        XCTAssertTrue(first.hasConversation)
        XCTAssertEqual(first.elapsed, 45)
        XCTAssertEqual(first.detail, "Haiku 4.5 · 45s")
    }

    /// A status the server grows after this build ships must decode to
    /// something drawable rather than throw the whole list away.
    func testUnknownStatusesAndUnknownFieldsSurvive() throws {
        let runs = try decodeRuns("""
        {"runs":[{"runId":"wf-1","name":"sweep","status":"quarantined",
                  "somethingNew":{"a":1},
                  "agents":[{"seq":0,"label":"a","status":"deferred"}]}]}
        """)
        let run = try XCTUnwrap(runs.first)
        XCTAssertEqual(run.status, .unknown)
        XCTAssertEqual(run.agents.first?.status, .unknown)
        XCTAssertFalse(run.canCancel)
    }

    /// Only the id is required. A run stripped to it still draws a row.
    func testOnlyTheIdIsRequired() throws {
        let runs = try decodeRuns("{\"runs\":[{\"runId\":\"wf-1\"}]}")
        let run = try XCTUnwrap(runs.first)
        XCTAssertEqual(run.name, "Workflow")
        XCTAssertEqual(run.status, .unknown)
        XCTAssertTrue(run.agents.isEmpty)
        XCTAssertEqual(run.progressLine, "No agents ran")
    }

    func testAnAgentWithoutAnIdIsDroppedRatherThanTheRun() throws {
        // The array decode is all-or-nothing per element, so a malformed
        // agent must not be able to take the run down with it: `agents`
        // falls back to empty and the run itself still lists.
        let runs = try decodeRuns("""
        {"runs":[{"runId":"wf-1","name":"sweep","status":"done",
                  "agents":[{"label":"no seq here"}]}]}
        """)
        XCTAssertEqual(runs.count, 1)
        XCTAssertTrue(try XCTUnwrap(runs.first).agents.isEmpty)
    }

    func testMissingRunsDecodesAsEmpty() throws {
        XCTAssertTrue(try decodeRuns("{}").isEmpty)
    }

    // MARK: - What the rows say

    func testALiveRunNamesItsPhaseAndHowFarThrough() {
        let run = WorkflowRun(
            runId: "wf-1",
            name: "digest",
            status: .running,
            phases: ["Classify", "Synthesize"],
            currentPhase: "Classify",
            agents: [
                WorkflowAgent(seq: 0, label: "a", status: .done),
                WorkflowAgent(seq: 1, label: "b", status: .running),
                WorkflowAgent(seq: 2, label: "c", status: .pending),
            ]
        )
        XCTAssertEqual(run.progressLine, "Classify · 1 of 3 agents")
        XCTAssertTrue(run.canCancel)
    }

    func testAFinishedRunNamesItsFailures() {
        let run = WorkflowRun(
            runId: "wf-1",
            name: "digest",
            status: .done,
            agents: [
                WorkflowAgent(seq: 0, label: "a", status: .done),
                WorkflowAgent(seq: 1, label: "b", status: .error),
            ]
        )
        XCTAssertEqual(run.progressLine, "2 agents · 1 failed")
    }

    func testASingleAgentIsNotPluralized() {
        let run = WorkflowRun(
            runId: "wf-1",
            name: "review",
            agents: [WorkflowAgent(seq: 0, label: "a")]
        )
        XCTAssertEqual(run.progressLine, "1 agent")
    }

    /// An agent that has not started has nothing to open, and a row that
    /// pushes an empty screen is worse than a row that does not push.
    func testAgentsWithoutAnEngineSessionHaveNoConversation() {
        XCTAssertFalse(WorkflowAgent(seq: 0, label: "a").hasConversation)
        XCTAssertFalse(
            WorkflowAgent(seq: 0, label: "a", engineSessionId: "").hasConversation
        )
        XCTAssertTrue(
            WorkflowAgent(seq: 0, label: "a", engineSessionId: "ses_x").hasConversation
        )
    }

    /// The error is what you open the row for, so it wins over the answer.
    func testTheOutcomeLinePrefersTheError() {
        let failed = WorkflowAgent(
            seq: 0,
            label: "a",
            status: .error,
            resultPreview: "partial",
            error: "Timed out after 15m"
        )
        XCTAssertEqual(failed.outcomeLine, "Timed out after 15m")
        let blank = WorkflowAgent(seq: 1, label: "b", resultPreview: "   \n ")
        XCTAssertNil(blank.outcomeLine)
    }

    // MARK: - Phase grouping

    func testAgentsGroupIntoThePhasesTheRunAnnounced() {
        let run = WorkflowRun(
            runId: "wf-1",
            name: "digest",
            phases: ["Classify", "Synthesize"],
            agents: [
                WorkflowAgent(seq: 0, label: "a", phase: "Classify"),
                WorkflowAgent(seq: 1, label: "b", phase: "Synthesize"),
                WorkflowAgent(seq: 2, label: "c", phase: "Classify"),
            ]
        )
        let groups = run.groupedAgents
        XCTAssertEqual(groups.map(\.title), ["Classify", "Synthesize"])
        XCTAssertEqual(groups.first?.agents.map(\.seq), [0, 2])
    }

    /// A phase the script never announced still gets its agents drawn, after
    /// the ones it did — losing rows would be worse than an odd order.
    func testAPhaseTheRunNeverAnnouncedStillAppears() {
        let run = WorkflowRun(
            runId: "wf-1",
            name: "digest",
            phases: ["Classify"],
            agents: [
                WorkflowAgent(seq: 0, label: "a", phase: "Classify"),
                WorkflowAgent(seq: 1, label: "b", phase: "Cleanup"),
            ]
        )
        XCTAssertEqual(run.groupedAgents.map(\.title), ["Classify", "Cleanup"])
    }

    /// One phase, or none, is a plain list — a section header repeating the
    /// run's own title says nothing.
    func testOnePhaseDrawsNoHeader() {
        let single = WorkflowRun(
            runId: "wf-1",
            name: "review",
            phases: ["Read"],
            agents: [
                WorkflowAgent(seq: 0, label: "a", phase: "Read"),
                WorkflowAgent(seq: 1, label: "b", phase: "Read"),
            ]
        )
        XCTAssertEqual(single.groupedAgents.count, 1)
        XCTAssertNil(single.groupedAgents.first?.title)

        let none = WorkflowRun(
            runId: "wf-2",
            name: "review",
            agents: [WorkflowAgent(seq: 0, label: "a")]
        )
        XCTAssertEqual(none.groupedAgents.count, 1)
        XCTAssertNil(none.groupedAgents.first?.title)
        XCTAssertTrue(WorkflowRun(runId: "wf-3", name: "x").groupedAgents.isEmpty)
    }

    func testDurationsReadShort() {
        XCTAssertEqual(WorkflowRun.duration(0.4), "<1s")
        XCTAssertEqual(WorkflowRun.duration(45), "45s")
        XCTAssertEqual(WorkflowRun.duration(90), "1m")
        XCTAssertEqual(WorkflowRun.duration(3600), "1h")
        XCTAssertEqual(WorkflowRun.duration(3720), "1h 2m")
    }

    /// The transcript route answers in the same entry shape the session view
    /// already renders, which is the whole reason the drill-in is free.
    func testAgentTranscriptDecodesTranscriptEntries() throws {
        let transcript = try JSONDecoder().decode(
            WorkflowAgentTranscript.self,
            from: Data("""
            {"entries":[{"id":"e1","type":"assistant","content":"Done."}]}
            """.utf8)
        )
        XCTAssertEqual(transcript.entries.count, 1)
        XCTAssertTrue(
            try JSONDecoder()
                .decode(WorkflowAgentTranscript.self, from: Data("{}".utf8))
                .entries
                .isEmpty
        )
    }
}
