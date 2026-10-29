import AlfredKit
import Foundation
import XCTest

final class AlfredClientTests: XCTestCase {
    /// A client whose every request goes to `handler`, with the requests it saw.
    private func makeClient(_ handler: @escaping @Sendable (URLRequest) -> StubReply) throws -> (AlfredClient, RequestLog) {
        let log = RequestLog()
        let client = try stubbedClient { request in
            log.record(request)
            return handler(request)
        }
        return (client, log)
    }

    private func assertFails(
        with expected: AlfredError,
        file: StaticString = #filePath,
        line: UInt = #line,
        _ operation: () async throws -> Void
    ) async {
        do {
            try await operation()
            XCTFail("expected \(expected), but the call succeeded", file: file, line: line)
        } catch {
            XCTAssertEqual(error as? AlfredError, expected, file: file, line: line)
        }
    }

    func testPingExpectsNoContentAndSendsTheCredentials() async throws {
        let (client, log) = try makeClient { _ in StubReply(status: 204) }
        try await client.ping()
        let entry = try XCTUnwrap(log.entries.first)
        XCTAssertEqual(entry.request.httpMethod, "GET")
        XCTAssertEqual(try encodedPath(entry.request), "/api/ping")
        assertCredentials(entry.request)
    }

    func testPingFailsOnAnyOtherStatus() async throws {
        let (client, _) = try makeClient { _ in StubReply(status: 200) }
        await assertFails(with: .http(status: 200, message: nil)) { try await client.ping() }
    }

    func testSendPostsTheCommandAsJSONAndAnyTwoHundredIsAccepted() async throws {
        let (client, log) = try makeClient { _ in StubReply(status: 202) }
        let command = try JSONDecoder().decode(Command.self, from: fixture("commands/message-send-files.json"))
        try await client.send(command)
        let entry = try XCTUnwrap(log.entries.first)
        XCTAssertEqual(entry.request.httpMethod, "POST")
        XCTAssertEqual(try encodedPath(entry.request), "/api/commands")
        XCTAssertEqual(entry.request.value(forHTTPHeaderField: "Content-Type"), "application/json")
        try assertSameJSON(entry.body, fixture("commands/message-send-files.json"))
        assertCredentials(entry.request)

        let (duplicate, _) = try makeClient { _ in StubReply(status: 200, chunks: [Data(#"{"accepted":false,"duplicate":true}"#.utf8)]) }
        try await duplicate.send(.runStop(runId: "k7m2qa"))
    }

    func testUploadStreamsTheFileAndPercentEncodesTheName() async throws {
        let directory = FileManager.default.temporaryDirectory.appending(path: UUID().uuidString, directoryHint: .isDirectory)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        addTeardownBlock { try? FileManager.default.removeItem(at: directory) }
        let file = directory.appending(path: "photo.jpg")
        let bytes = Data((0..<4096).map { UInt8($0 % 251) })
        try bytes.write(to: file)

        let (client, log) = try makeClient { _ in StubReply(chunks: [((try? fixture("responses/upload-result.json")) ?? Data())]) }
        let uploaded = try await client.upload(fileAt: file, name: "my photo 照片.jpg", contentType: "image/jpeg")
        XCTAssertEqual(uploaded.path, "inbox/2026-10-25/IMG_0413.jpg")
        XCTAssertEqual(uploaded.kind, FileKind.image)

        let entry = try XCTUnwrap(log.entries.first)
        XCTAssertEqual(entry.request.httpMethod, "POST")
        XCTAssertEqual(try encodedPath(entry.request), "/api/uploads")
        XCTAssertEqual(try encodedQuery(entry.request), "name=my%20photo%20%E7%85%A7%E7%89%87.jpg")
        XCTAssertEqual(entry.request.value(forHTTPHeaderField: "Content-Type"), "image/jpeg")
        XCTAssertEqual(entry.body, bytes)
        assertCredentials(entry.request)
    }

    func testUploadWithAProgressCallbackSendsTheSameRequest() async throws {
        let directory = FileManager.default.temporaryDirectory.appending(path: UUID().uuidString, directoryHint: .isDirectory)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        addTeardownBlock { try? FileManager.default.removeItem(at: directory) }
        let file = directory.appending(path: "quote.pdf")
        let bytes = Data((0..<2048).map { UInt8($0 % 241) })
        try bytes.write(to: file)

        let (client, log) = try makeClient { _ in StubReply(chunks: [((try? fixture("responses/upload-result.json")) ?? Data())]) }
        let uploaded = try await client.upload(fileAt: file, name: "quote.pdf", contentType: "application/pdf") { fraction in
            XCTAssertTrue((0...1).contains(fraction))
        }
        XCTAssertEqual(uploaded.path, "inbox/2026-10-25/IMG_0413.jpg")
        let entry = try XCTUnwrap(log.entries.first)
        XCTAssertEqual(try encodedQuery(entry.request), "name=quote.pdf")
        XCTAssertEqual(entry.request.value(forHTTPHeaderField: "Content-Type"), "application/pdf")
        XCTAssertEqual(entry.body, bytes)
        assertCredentials(entry.request)
    }

    func testRunsAndRunDetailDecodeTheirFixtures() async throws {
        let (client, log) = try makeClient { request in
            // The list and the detail are answered from the same handler: the path picks the fixture.
            if request.url?.path == "/api/runs" {
                return StubReply(chunks: [(try? fixture("responses/run-list.json")) ?? Data()])
            }
            return StubReply(chunks: [(try? fixture("responses/run-detail.json")) ?? Data()])
        }
        let runs = try await client.runs()
        XCTAssertEqual(runs.map(\.id), ["d8j3sx", "h6w4tz", "k7m2qa"])
        XCTAssertEqual(try encodedPath(try XCTUnwrap(log.entries.first).request), "/api/runs")
        XCTAssertEqual(try XCTUnwrap(log.entries.first).request.httpMethod, "GET")

        let detail = try await client.run(id: "k7m2qa")
        XCTAssertEqual(detail.run.id, "k7m2qa")
        XCTAssertEqual(detail.steps.map(\.tool), ["WebSearch", "Task", "Write"])
        XCTAssertEqual(try encodedPath(try XCTUnwrap(log.entries.last).request), "/api/runs/k7m2qa")
        assertCredentials(try XCTUnwrap(log.entries.last).request)
    }

    func testFileEncodesEachPathSegmentAndSavesTheDownload() async throws {
        let bytes = Data("# VPS\n".utf8)
        let (client, log) = try makeClient { _ in StubReply(chunks: [bytes]) }
        let saved = try await client.file(path: "reports/vps report.md")
        defer { try? FileManager.default.removeItem(at: saved.deletingLastPathComponent()) }
        XCTAssertEqual(saved.lastPathComponent, "vps report.md")
        XCTAssertEqual(try Data(contentsOf: saved), bytes)
        let entry = try XCTUnwrap(log.entries.first)
        XCTAssertEqual(entry.request.httpMethod, "GET")
        XCTAssertEqual(try encodedPath(entry.request), "/api/files/reports/vps%20report.md")
        assertCredentials(entry.request)
    }

    func testRegisterPushPostsTheRegistrationAndExpectsNoContent() async throws {
        let (client, log) = try makeClient { _ in StubReply(status: 204) }
        try await client.registerPush(PushRegistration(
            token: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
            environment: .development
        ))
        let entry = try XCTUnwrap(log.entries.first)
        XCTAssertEqual(entry.request.httpMethod, "POST")
        XCTAssertEqual(try encodedPath(entry.request), "/api/push")
        try assertSameJSON(entry.body, fixture("requests/push-registration.json"))
        assertCredentials(entry.request)
    }

    func testErrorsMapToTheirCases() async throws {
        let (unauthorized, _) = try makeClient { _ in StubReply(status: 401) }
        await assertFails(with: .unauthorized) { _ = try await unauthorized.runs() }

        let (forbidden, _) = try makeClient { _ in StubReply(status: 403, chunks: [Data("<html>denied</html>".utf8)]) }
        await assertFails(with: .forbidden) { try await forbidden.ping() }

        let (failing, _) = try makeClient { _ in StubReply(status: 500, chunks: [(try? fixture("responses/error.json")) ?? Data()]) }
        await assertFails(with: .http(status: 500, message: "no live or queued run k7m2qa")) {
            _ = try await failing.run(id: "k7m2qa")
        }

        let (bare, _) = try makeClient { _ in StubReply(status: 500) }
        await assertFails(with: .http(status: 500, message: nil)) { try await bare.send(.runStop(runId: "k7m2qa")) }
    }

    func testTransportErrorsPassThrough() async throws {
        let (client, _) = try makeClient { _ in StubReply(failure: .notConnectedToInternet) }
        do {
            try await client.ping()
            XCTFail("expected a transport error")
        } catch let error as URLError {
            XCTAssertEqual(error.code, .notConnectedToInternet)
        }
    }

    func testTasksAndTaskDetailDecodeTheirFixtures() async throws {
        let (client, log) = try makeClient { request in
            if request.url?.path == "/api/tasks" {
                return StubReply(chunks: [(try? fixture("responses/task-list.json")) ?? Data()])
            }
            return StubReply(chunks: [(try? fixture("responses/task-detail.json")) ?? Data()])
        }
        let list = try await client.tasks()
        XCTAssertEqual(list.timeZone, "Asia/Taipei")
        XCTAssertEqual(list.tasks.count, 4)
        let listed = try XCTUnwrap(log.entries.first)
        XCTAssertEqual(listed.request.httpMethod, "GET")
        XCTAssertEqual(try encodedPath(listed.request), "/api/tasks")
        assertCredentials(listed.request)

        let detail = try await client.task(id: "p3r8vx")
        XCTAssertEqual(detail.task.id, "p3r8vx")
        XCTAssertEqual(detail.runs.count, 2)
        let fetched = try XCTUnwrap(log.entries.last)
        XCTAssertEqual(try encodedPath(fetched.request), "/api/tasks/p3r8vx")
        assertCredentials(fetched.request)
    }

    func testCreateTaskPostsTheCommandAndDecodesTheTask() async throws {
        let (client, log) = try makeClient { _ in StubReply(status: 201, chunks: [(try? fixture("responses/task-result.json")) ?? Data()]) }
        let draft = TaskDraft(
            title: "每日 VPS 价格",
            brief: "查三家供应商官网的定价页，和昨天的报告比较，只列出变化。",
            schedule: .daily(time: TimeOfDay(hour: 9, minute: 0))
        )
        let created = try await client.createTask(draft)
        XCTAssertEqual(created.id, "p3r8vx")
        let entry = try XCTUnwrap(log.entries.first)
        XCTAssertEqual(entry.request.httpMethod, "POST")
        XCTAssertEqual(try encodedPath(entry.request), "/api/commands")
        try assertSameJSON(entry.body, fixture("commands/task-create-minimal.json"))
        assertCredentials(entry.request)
    }

    func testUpdateTaskPostsOnlyTheChangedFieldsAndDecodesTheTask() async throws {
        let (client, log) = try makeClient { _ in StubReply(chunks: [(try? fixture("responses/task-result.json")) ?? Data()]) }
        let updated = try await client.updateTask(
            id: "p3r8vx",
            changes: TaskChanges(schedule: .interval(hours: 6), budgetUsd: 1)
        )
        XCTAssertEqual(updated.id, "p3r8vx")
        let entry = try XCTUnwrap(log.entries.first)
        XCTAssertEqual(try encodedPath(entry.request), "/api/commands")
        try assertSameJSON(entry.body, fixture("commands/task-update-schedule.json"))
        assertCredentials(entry.request)
    }

    func testRunTaskPostsTaskRunAndAnyTwoHundredIsAccepted() async throws {
        let (client, log) = try makeClient { _ in StubReply(status: 202, chunks: [Data(#"{"accepted":true}"#.utf8)]) }
        try await client.runTask(id: "p3r8vx")
        let entry = try XCTUnwrap(log.entries.first)
        XCTAssertEqual(entry.request.httpMethod, "POST")
        try assertSameJSON(entry.body, fixture("commands/task-run.json"))
        assertCredentials(entry.request)
    }

    private let revisedVersion = "5d726c9ddcb2d6a8fad41e6213426bdeb94c6acd"

    func testDocumentsAndDocumentDetailDecodeTheirFixtures() async throws {
        let (client, log) = try makeClient { request in
            if request.url?.path == "/api/documents" {
                return StubReply(chunks: [(try? fixture("responses/document-list.json")) ?? Data()])
            }
            return StubReply(chunks: [(try? fixture("responses/document-detail.json")) ?? Data()])
        }
        let list = try await client.documents()
        XCTAssertEqual(list.documents.map(\.id), ["r4f7ma", "w6k2tn"])
        let listed = try XCTUnwrap(log.entries.first)
        XCTAssertEqual(listed.request.httpMethod, "GET")
        XCTAssertEqual(try encodedPath(listed.request), "/api/documents")
        assertCredentials(listed.request)

        let detail = try await client.document(id: "r4f7ma")
        XCTAssertEqual(detail.document.id, "r4f7ma")
        XCTAssertEqual(detail.versions.count, 4)
        let fetched = try XCTUnwrap(log.entries.last)
        XCTAssertEqual(fetched.request.httpMethod, "GET")
        XCTAssertEqual(try encodedPath(fetched.request), "/api/documents/r4f7ma")
        assertCredentials(fetched.request)
    }

    func testReviseSendsTheBatchAndDecodesTheRevisionRun() async throws {
        let (client, log) = try makeClient { _ in StubReply(status: 202, chunks: [(try? fixture("responses/revision-accepted.json")) ?? Data()]) }
        let accepted = try await client.revise(
            documentId: "r4f7ma",
            version: revisedVersion,
            annotations: [
                AnnotationDraft(
                    target: .passage(quote: "Hetzner 的 CX22 仍是 €4.51/月", prefix: "对比结论：", suffix: "，其余两家都上涨了。"),
                    comment: "这个价格请再核对一下官网，别用缓存的数据。"
                ),
                AnnotationDraft(target: .passage(quote: "DigitalOcean 的基础款降到 $4", prefix: "", suffix: "/月。"), comment: "这一条的日期也写上。"),
                AnnotationDraft(target: .document, comment: "开头加一段三句话的结论。"),
            ]
        )
        XCTAssertEqual(accepted.runId, "s2d8kp")
        XCTAssertEqual(accepted.annotations.count, 3)
        let entry = try XCTUnwrap(log.entries.first)
        XCTAssertEqual(entry.request.httpMethod, "POST")
        XCTAssertEqual(try encodedPath(entry.request), "/api/commands")
        try assertSameJSON(entry.body, fixture("commands/document-revise.json"))
        assertCredentials(entry.request)
    }

    func testReviseFailsWithTheStatusAndMessageOfARefusal() async throws {
        let (client, _) = try makeClient { _ in
            StubReply(status: 409, chunks: [Data(#"{"error":"version: not the document's current version"}"#.utf8)])
        }
        await assertFails(with: .http(status: 409, message: "version: not the document's current version")) {
            _ = try await client.revise(documentId: "r4f7ma", version: revisedVersion, annotations: [AnnotationDraft(target: .document, comment: "x")])
        }
    }

    func testUndoRevisionSendsTheCommandAndDecodesTheDocument() async throws {
        let (client, log) = try makeClient { _ in StubReply(chunks: [(try? fixture("responses/document-result.json")) ?? Data()]) }
        let document = try await client.undoRevision(documentId: "r4f7ma", runId: "x4n7mj")
        XCTAssertEqual(document.id, "r4f7ma")
        XCTAssertEqual(document.version, revisedVersion)
        let entry = try XCTUnwrap(log.entries.first)
        XCTAssertEqual(entry.request.httpMethod, "POST")
        try assertSameJSON(entry.body, fixture("commands/document-undo.json"))
        assertCredentials(entry.request)
    }

    func testFileFetchesTheVersionTheQueryNames() async throws {
        let bytes = Data("# VPS 价格对比\n".utf8)
        let (client, log) = try makeClient { _ in StubReply(chunks: [bytes]) }
        let saved = try await client.file(path: "reports/vps.md", version: "248e89ba3aad47311d9cf0d57bf83b038a724f1f")
        defer { try? FileManager.default.removeItem(at: saved.deletingLastPathComponent()) }
        XCTAssertEqual(try Data(contentsOf: saved), bytes)
        let entry = try XCTUnwrap(log.entries.first)
        XCTAssertEqual(entry.request.httpMethod, "GET")
        XCTAssertEqual(try encodedPath(entry.request), "/api/files/reports/vps.md")
        XCTAssertEqual(try encodedQuery(entry.request), "version=248e89ba3aad47311d9cf0d57bf83b038a724f1f")
        assertCredentials(entry.request)

        let (live, liveLog) = try makeClient { _ in StubReply(chunks: [bytes]) }
        let liveCopy = try await live.file(path: "reports/vps.md")
        defer { try? FileManager.default.removeItem(at: liveCopy.deletingLastPathComponent()) }
        XCTAssertNil(try encodedQuery(try XCTUnwrap(liveLog.entries.first).request), "the live file has no query")
    }

    func testIdeasFetchesTheListAndDecodesIt() async throws {
        let (client, log) = try makeClient { _ in StubReply(chunks: [(try? fixture("responses/idea-list.json")) ?? Data()]) }
        let list = try await client.ideas()
        XCTAssertEqual(list.ideas.count, 5)
        XCTAssertEqual(list.generatingRunId, "c9t5hq")
        let entry = try XCTUnwrap(log.entries.first)
        XCTAssertEqual(entry.request.httpMethod, "GET")
        XCTAssertEqual(try encodedPath(entry.request), "/api/ideas")
        assertCredentials(entry.request)
    }

    func testAcceptIdeaPostsTheCommandAndDecodesTheIdeaAndItsTask() async throws {
        let (client, log) = try makeClient { _ in StubReply(chunks: [(try? fixture("responses/idea-accepted.json")) ?? Data()]) }
        let accepted = try await client.acceptIdea(
            ideaId: "h3v8ct",
            title: "对比三家 VPS 的带宽配额",
            brief: "查 Hetzner、Vultr 和 DigitalOcean 官网的带宽与流量政策，整理成一张表，附上来源链接。",
            schedule: nil,
            model: .sonnet,
            budgetUsd: 1
        )
        XCTAssertEqual(accepted.idea.id, "k4p9rx")
        XCTAssertEqual(accepted.task.id, "n2c7bq")
        let entry = try XCTUnwrap(log.entries.first)
        XCTAssertEqual(entry.request.httpMethod, "POST")
        XCTAssertEqual(try encodedPath(entry.request), "/api/commands")
        try assertSameJSON(entry.body, fixture("commands/idea-accept-once.json"))
        assertCredentials(entry.request)
    }

    func testRejectIdeaPostsTheCommandAndDecodesTheIdea() async throws {
        let (client, log) = try makeClient { _ in StubReply(chunks: [(try? fixture("responses/idea-result.json")) ?? Data()]) }
        let rejected = try await client.rejectIdea(ideaId: "m7x2zd", reason: .notInterested, note: "我自己会翻。")
        XCTAssertEqual(rejected.id, "m7x2zd")
        XCTAssertEqual(rejected.state, .rejected)
        let entry = try XCTUnwrap(log.entries.first)
        XCTAssertEqual(entry.request.httpMethod, "POST")
        XCTAssertEqual(try encodedPath(entry.request), "/api/commands")
        try assertSameJSON(entry.body, fixture("commands/idea-reject.json"))
        assertCredentials(entry.request)
    }

    func testGenerateIdeasPostsTheCommandAndReturnsTheRunId() async throws {
        let (client, log) = try makeClient { _ in
            StubReply(status: 202, chunks: [(try? fixture("responses/idea-generation-accepted.json")) ?? Data()])
        }
        let runId = try await client.generateIdeas()
        XCTAssertEqual(runId, "c9t5hq")
        let entry = try XCTUnwrap(log.entries.first)
        XCTAssertEqual(entry.request.httpMethod, "POST")
        XCTAssertEqual(try encodedPath(entry.request), "/api/commands")
        try assertSameJSON(entry.body, fixture("commands/idea-generate.json"))
        assertCredentials(entry.request)
    }

    func testAnIdeaRefusalFailsWithTheStatusAndMessage() async throws {
        let (client, _) = try makeClient { _ in
            StubReply(status: 409, chunks: [Data(#"{"error":"a generation is already queued or running"}"#.utf8)])
        }
        await assertFails(with: .http(status: 409, message: "a generation is already queued or running")) {
            _ = try await client.generateIdeas()
        }
    }

    func testSettingsFetchesTheDetailAndDecodesIt() async throws {
        let (client, log) = try makeClient { _ in StubReply(chunks: [(try? fixture("responses/settings-detail.json")) ?? Data()]) }
        let detail = try await client.settings()
        XCTAssertEqual(detail.spentTodayUsd, 4.82)
        XCTAssertEqual(detail.settings.overridden, [.model, .dailyBudgetUsd, .ideasAt])
        let entry = try XCTUnwrap(log.entries.first)
        XCTAssertEqual(entry.request.httpMethod, "GET")
        XCTAssertEqual(try encodedPath(entry.request), "/api/settings")
        assertCredentials(entry.request)
    }

    func testUpdateSettingsPostsTheCommandAndDecodesTheSettings() async throws {
        let (client, log) = try makeClient { _ in StubReply(chunks: [(try? fixture("responses/settings-result.json")) ?? Data()]) }
        let settings = try await client.updateSettings(SettingsChanges(model: .opus, dailyBudgetUsd: 30, reset: [.runBudgetUsd]))
        XCTAssertNil(settings.ideasAt)
        let entry = try XCTUnwrap(log.entries.first)
        XCTAssertEqual(entry.request.httpMethod, "POST")
        XCTAssertEqual(try encodedPath(entry.request), "/api/commands")
        try assertSameJSON(entry.body, fixture("commands/settings-update.json"))
        assertCredentials(entry.request)
    }

    func testUpdateSettingsTurnsTheIdeasTimeOffAsNull() async throws {
        let (client, log) = try makeClient { _ in StubReply(chunks: [(try? fixture("responses/settings-result.json")) ?? Data()]) }
        _ = try await client.updateSettings(SettingsChanges(ideasAt: .off))
        let entry = try XCTUnwrap(log.entries.first)
        try assertSameJSON(entry.body, fixture("commands/settings-update-ideas-off.json"))
    }

    func testRulesFetchesTheTextItsVersionAndTheLimit() async throws {
        let (client, log) = try makeClient { _ in StubReply(chunks: [(try? fixture("responses/rules.json")) ?? Data()]) }
        let rules = try await client.rules()
        XCTAssertTrue(rules.text.hasPrefix("# Workspace rules"))
        XCTAssertEqual(rules.version, "3ca90a087679c144795ef3d87cd728ca2fc95886596e863550f376b76b61f10d")
        XCTAssertEqual(rules.maxBytes, 8192)
        let entry = try XCTUnwrap(log.entries.first)
        XCTAssertEqual(entry.request.httpMethod, "GET")
        XCTAssertEqual(try encodedPath(entry.request), "/api/rules")
        assertCredentials(entry.request)
    }

    func testRulesFailsWithTheStatusAndMessageOfARefusal() async throws {
        let (client, _) = try makeClient { _ in
            StubReply(status: 413, chunks: [Data(#"{"error":"ALFRED.md is over 65536 bytes, too long to edit here."}"#.utf8)])
        }
        await assertFails(with: .http(status: 413, message: "ALFRED.md is over 65536 bytes, too long to edit here.")) {
            _ = try await client.rules()
        }
    }

    func testSaveRulesPostsTheCommandAndDecodesTheNewRules() async throws {
        let newVersion = String(repeating: "a", count: 64)
        let saved = Data(##"{"text":"# Workspace rules\n","version":"\##(newVersion)","maxBytes":8192}"##.utf8)
        let (client, log) = try makeClient { _ in StubReply(chunks: [saved]) }
        let command = try JSONDecoder().decode(Command.self, from: fixture("commands/rules-save.json"))
        guard case let .rulesSave(text, version) = command else { return XCTFail("the fixture is not a rules.save: \(command)") }

        let rules = try await client.saveRules(text: text, version: version)
        XCTAssertEqual(rules.text, "# Workspace rules\n")
        XCTAssertEqual(rules.version, newVersion)
        XCTAssertEqual(rules.maxBytes, 8192)
        let entry = try XCTUnwrap(log.entries.first)
        XCTAssertEqual(entry.request.httpMethod, "POST")
        XCTAssertEqual(try encodedPath(entry.request), "/api/commands")
        XCTAssertEqual(entry.request.value(forHTTPHeaderField: "Content-Type"), "application/json")
        try assertSameJSON(entry.body, fixture("commands/rules-save.json"))
        assertCredentials(entry.request)
    }

    func testSaveRulesMapsAConflictAndARefusedTextToTheirStatusAndMessage() async throws {
        let (stale, _) = try makeClient { _ in
            StubReply(status: 409, chunks: [Data(#"{"error":"version: not the current version of ALFRED.md"}"#.utf8)])
        }
        await assertFails(with: .http(status: 409, message: "version: not the current version of ALFRED.md")) {
            _ = try await stale.saveRules(text: "x", version: "old")
        }

        let (tooLong, _) = try makeClient { _ in
            StubReply(status: 400, chunks: [Data(#"{"error":"text: must be at most 8192 bytes"}"#.utf8)])
        }
        await assertFails(with: .http(status: 400, message: "text: must be at most 8192 bytes")) {
            _ = try await tooLong.saveRules(text: "x", version: "v")
        }

        let (unauthorized, _) = try makeClient { _ in StubReply(status: 401) }
        await assertFails(with: .unauthorized) { _ = try await unauthorized.saveRules(text: "x", version: "v") }
    }

    // MARK: Memories

    func testMemoriesFetchesTheListAndHowManyAreInThePrompt() async throws {
        let (client, log) = try makeClient { _ in StubReply(chunks: [(try? fixture("responses/memory-list.json")) ?? Data()]) }
        let list = try await client.memories()
        XCTAssertEqual(list.memories.count, 5)
        XCTAssertEqual(list.memories.first?.file, "prefer-short-answers.md")
        XCTAssertEqual(list.promptCount, 3)
        let entry = try XCTUnwrap(log.entries.first)
        XCTAssertEqual(entry.request.httpMethod, "GET")
        XCTAssertEqual(try encodedPath(entry.request), "/api/memories")
        assertCredentials(entry.request)
    }

    func testCreateMemoryPostsTheCommandAndDecodesTheMemory() async throws {
        let (client, log) = try makeClient { _ in StubReply(status: 201, chunks: [(try? fixture("responses/memory-result.json")) ?? Data()]) }
        let command = try JSONDecoder().decode(Command.self, from: fixture("commands/memory-create.json"))
        guard case let .memoryCreate(name, description, kind, body) = command else { return XCTFail("the fixture is not a memory.create: \(command)") }

        let memory = try await client.createMemory(name: name, description: description, kind: kind, body: body)
        XCTAssertEqual(memory.file, "prefer-short-answers.md")
        XCTAssertEqual(memory.version, "a1075618ddd4346fc0569eb1a35aa04936451c96997b30d4eeca95cda23fc7a0")
        let entry = try XCTUnwrap(log.entries.first)
        XCTAssertEqual(entry.request.httpMethod, "POST")
        XCTAssertEqual(try encodedPath(entry.request), "/api/commands")
        XCTAssertEqual(entry.request.value(forHTTPHeaderField: "Content-Type"), "application/json")
        try assertSameJSON(entry.body, fixture("commands/memory-create.json"))
        assertCredentials(entry.request)
    }

    func testUpdateMemoryPostsTheCommandAgainstTheVersionAndDecodesTheMemory() async throws {
        let (client, log) = try makeClient { _ in StubReply(chunks: [(try? fixture("responses/memory-result.json")) ?? Data()]) }
        let command = try JSONDecoder().decode(Command.self, from: fixture("commands/memory-update.json"))
        guard case let .memoryUpdate(file, version, name, description, kind, body) = command else {
            return XCTFail("the fixture is not a memory.update: \(command)")
        }

        let memory = try await client.updateMemory(file: file, version: version, name: name, description: description, kind: kind, body: body)
        XCTAssertEqual(memory.name, "回答要简短")
        XCTAssertEqual(memory.updated, "2026-10-29")
        let entry = try XCTUnwrap(log.entries.first)
        XCTAssertEqual(entry.request.httpMethod, "POST")
        XCTAssertEqual(try encodedPath(entry.request), "/api/commands")
        try assertSameJSON(entry.body, fixture("commands/memory-update.json"))
        assertCredentials(entry.request)
    }

    func testDeleteMemoryPostsTheCommandAndTakesTheAnswerAsDone() async throws {
        let (client, log) = try makeClient { _ in StubReply(chunks: [Data(#"{"deleted":true}"#.utf8)]) }
        let command = try JSONDecoder().decode(Command.self, from: fixture("commands/memory-delete.json"))
        guard case let .memoryDelete(file, version) = command else { return XCTFail("the fixture is not a memory.delete: \(command)") }

        try await client.deleteMemory(file: file, version: version)
        let entry = try XCTUnwrap(log.entries.first)
        XCTAssertEqual(entry.request.httpMethod, "POST")
        XCTAssertEqual(try encodedPath(entry.request), "/api/commands")
        try assertSameJSON(entry.body, fixture("commands/memory-delete.json"))
        assertCredentials(entry.request)
    }

    func testMemoryCommandsMapAStaleVersionABusyAlfredAndAGoneMemoryToTheirStatusAndMessage() async throws {
        let (stale, _) = try makeClient { _ in
            StubReply(status: 409, chunks: [Data(#"{"error":"version: not the current version of prefer-short-answers.md"}"#.utf8)])
        }
        await assertFails(with: .http(status: 409, message: "version: not the current version of prefer-short-answers.md")) {
            _ = try await stale.updateMemory(file: "prefer-short-answers.md", version: "old", name: "n", description: "", kind: "user", body: "")
        }
        await assertFails(with: .http(status: 409, message: "version: not the current version of prefer-short-answers.md")) {
            try await stale.deleteMemory(file: "prefer-short-answers.md", version: "old")
        }

        let (busy, _) = try makeClient { _ in
            StubReply(status: 409, chunks: [Data(#"{"error":"Alfred is tidying memory right now; try again shortly."}"#.utf8)])
        }
        await assertFails(with: .http(status: 409, message: "Alfred is tidying memory right now; try again shortly.")) {
            _ = try await busy.createMemory(name: "n", description: "", kind: "user", body: "")
        }

        let (gone, _) = try makeClient { _ in
            StubReply(status: 404, chunks: [Data(#"{"error":"no memory prefer-short-answers.md"}"#.utf8)])
        }
        await assertFails(with: .http(status: 404, message: "no memory prefer-short-answers.md")) {
            _ = try await gone.updateMemory(file: "prefer-short-answers.md", version: "v", name: "n", description: "", kind: "user", body: "")
        }
        await assertFails(with: .http(status: 404, message: "no memory prefer-short-answers.md")) {
            try await gone.deleteMemory(file: "prefer-short-answers.md", version: "v")
        }

        let (unauthorized, _) = try makeClient { _ in StubReply(status: 401) }
        await assertFails(with: .unauthorized) { _ = try await unauthorized.memories() }
    }
}
