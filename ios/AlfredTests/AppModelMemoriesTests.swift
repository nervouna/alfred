import AlfredKit
import XCTest

@testable import Alfred

/// The app's view of Alfred's long-term memories: read from `GET /api/memories`, changed by `memory.create`,
/// `memory.update` and `memory.delete`.
@MainActor
final class AppModelMemoriesTests: XCTestCase {
    private let staleMessage = "version: not the current version of prefer-short-answers.md"
    private let busyMessage = "Alfred is tidying memory right now; try again shortly."

    /// A paired model on a fake server. `reads` answers `GET /api/memories` in turn, `commands` answers `POST /api/commands`.
    private func makeModel(reads: [StubReply] = [], commands: [StubReply] = []) throws -> (AppModel, StubServer) {
        let readScript = ReplyScript(reads.isEmpty ? [StubReply(status: 500)] : reads)
        let commandScript = ReplyScript(commands.isEmpty ? [StubReply(status: 500)] : commands)
        let server = StubServer { request in
            switch request.url?.path ?? "" {
            case "/api/memories": return readScript.next()
            case "/api/commands": return commandScript.next()
            case "/api/events": return .stream()
            default: return StubReply(status: 404)
            }
        }
        let model = AppModel(store: InMemoryCredentialStore(try server.credentials()), session: server.session)
        addTeardownBlock { @MainActor in
            model.background()
            withExtendedLifetime(server) {}
        }
        return (model, server)
    }

    private func list(_ memories: [[String: Any]], promptCount: Int? = nil) throws -> StubReply {
        StubReply(chunks: [try TestData.memoryListJSON(memories, promptCount: promptCount)])
    }

    private func result(_ memory: [String: Any], status: Int = 200) throws -> StubReply {
        StubReply(status: status, chunks: [try TestData.memoryResultJSON(memory)])
    }

    private func error(_ message: String, status: Int) -> StubReply {
        StubReply(status: status, chunks: [Data(#"{"error":"\#(message)"}"#.utf8)])
    }

    private func sentCommand(_ server: StubServer) throws -> NSDictionary {
        NSDictionary(dictionary: try XCTUnwrap(server.requests(to: "/api/commands").first?.chatCommand))
    }

    /// The model after it has read two memories.
    private func loadedModel(commands: [StubReply]) async throws -> (AppModel, StubServer) {
        let (model, server) = try makeModel(
            reads: [try list([
                TestData.memoryObject("回答要简短", file: "prefer-short-answers.md", description: "先给结论。", kind: "preference", body: "正文", version: "v1"),
                TestData.memoryObject("住在上海", file: "lives-in-shanghai.md", kind: "user", version: "v2"),
            ], promptCount: 2)],
            commands: commands
        )
        await model.refreshMemories()
        return (model, server)
    }

    // MARK: Reading

    func testReadingKeepsTheMemoriesAndHowManyAreInThePrompt() async throws {
        let (model, server) = try makeModel(reads: [try list([
            TestData.memoryObject("甲"), TestData.memoryObject("乙"), TestData.memoryObject("丙"),
        ], promptCount: 2)])
        XCTAssertFalse(model.memoryCatalog.hasLoaded)

        let read = await model.refreshMemories()

        XCTAssertEqual(model.memoryCatalog.memories.map(\.name), ["甲", "乙", "丙"])
        XCTAssertEqual(model.memoryCatalog.promptCount, 2)
        XCTAssertTrue(model.memoryCatalog.hasLoaded)
        XCTAssertEqual(read?.memories.count, 3, "the read is handed back too")
        XCTAssertFalse(model.isLoadingMemories)
        XCTAssertNil(model.actionFailure)
        XCTAssertEqual(server.requests(to: "/api/memories").count, 1)
    }

    func testAReadReplacesWhatWasKept() async throws {
        let (model, _) = try makeModel(reads: [try list([TestData.memoryObject("旧")]), try list([TestData.memoryObject("新")])])
        await model.refreshMemories()
        await model.refreshMemories()
        XCTAssertEqual(model.memoryCatalog.memories.map(\.name), ["新"])
    }

    func testAFailedReadShowsTheUsualAlertAndKeepsWhatWasRead() async throws {
        let (model, _) = try makeModel(reads: [try list([TestData.memoryObject("甲")]), error("bad gateway", status: 502)])
        await model.refreshMemories()

        let read = await model.refreshMemories()

        XCTAssertNil(read)
        XCTAssertEqual(model.actionFailure, "服务器返回 502：bad gateway")
        XCTAssertEqual(model.memoryCatalog.memories.map(\.name), ["甲"])
        XCTAssertFalse(model.isLoadingMemories)
    }

    func testAFailedFirstReadLeavesTheCatalogUnloaded() async throws {
        let (model, _) = try makeModel(reads: [error("bad gateway", status: 502)])
        await model.refreshMemories()
        XCTAssertFalse(model.memoryCatalog.hasLoaded)
        XCTAssertEqual(model.actionFailure, "服务器返回 502：bad gateway")
    }

    func testARefusedReadShowsTheAccessErrorOfTheStream() async throws {
        let (model, _) = try makeModel(reads: [StubReply(status: 401)])
        await model.refreshMemories()
        XCTAssertEqual(model.streamFailure, .unauthorized)
    }

    func testAReadWhileUnpairedDoesNothing() async throws {
        let (model, server) = try makeModel(reads: [try list([TestData.memoryObject("甲")])])
        model.unpair()
        let read = await model.refreshMemories()
        XCTAssertNil(read)
        XCTAssertFalse(model.memoryCatalog.hasLoaded)
        XCTAssertEqual(server.requests(to: "/api/memories").count, 0)
    }

    // MARK: Creating

    func testCreatingSendsTheTrimmedLinesAndListsTheNewMemoryAtOnce() async throws {
        let created = TestData.memoryObject("Metric units", file: "metric-units.md", description: "Use metric.", kind: "preference", updated: "2026-10-29", body: "Convert miles.", version: "v9")
        let (model, server) = try await loadedModel(commands: [try result(created, status: 201)])
        var draft = MemoryDraft()
        draft.name = "  Metric units "
        draft.description = "Use metric. "
        draft.kind = "preference"
        draft.body = "Convert miles."

        let outcome = await model.saveMemory(draft)

        guard case let .saved(memory) = outcome else { return XCTFail("the save did not work: \(outcome)") }
        XCTAssertEqual(memory.file, "metric-units.md")
        XCTAssertEqual(model.memoryCatalog.memories.first, memory, "the new memory is listed first, without a read")
        XCTAssertEqual(model.memoryCatalog.memories.count, 3)
        XCTAssertEqual(try sentCommand(server), [
            "type": "memory.create", "name": "Metric units", "description": "Use metric.", "kind": "preference", "body": "Convert miles.",
        ] as NSDictionary)
        XCTAssertNil(model.actionFailure)
        XCTAssertEqual(server.requests(to: "/api/memories").count, 1, "a save is not followed by a read")
    }

    // MARK: Updating

    func testUpdatingSendsTheFieldsAgainstTheVersionAndKeepsTheMemoryTheServerAnswersWith() async throws {
        let updated = TestData.memoryObject("回答要简短！", file: "prefer-short-answers.md", description: "先给结论。", kind: "project", updated: "2026-10-29", body: "正文", version: "v3")
        let (model, server) = try await loadedModel(commands: [try result(updated)])
        var draft = MemoryDraft(editing: try XCTUnwrap(model.memoryCatalog.memory(file: "prefer-short-answers.md")))
        draft.name = "回答要简短！"
        draft.kind = "project"

        let outcome = await model.saveMemory(draft)

        guard case let .saved(memory) = outcome else { return XCTFail("the save did not work: \(outcome)") }
        XCTAssertEqual(memory.version, "v3")
        XCTAssertEqual(model.memoryCatalog.memory(file: "prefer-short-answers.md")?.name, "回答要简短！")
        XCTAssertEqual(model.memoryCatalog.memories.first?.file, "prefer-short-answers.md")
        XCTAssertEqual(model.memoryCatalog.memories.count, 2, "the edited memory replaced the old one")
        XCTAssertEqual(try sentCommand(server), [
            "type": "memory.update", "file": "prefer-short-answers.md", "version": "v1",
            "name": "回答要简短！", "description": "先给结论。", "kind": "project", "body": "正文",
        ] as NSDictionary)
        XCTAssertNil(model.actionFailure)
    }

    func testAStaleVersionIsStaleAndNoAlert() async throws {
        let (model, _) = try await loadedModel(commands: [error(staleMessage, status: 409)])
        var draft = MemoryDraft(editing: try XCTUnwrap(model.memoryCatalog.memory(file: "prefer-short-answers.md")))
        draft.body = "新正文"

        let outcome = await model.saveMemory(draft)

        XCTAssertEqual(outcome, .stale)
        XCTAssertNil(model.actionFailure, "the form asks what to do instead")
        XCTAssertEqual(model.memoryCatalog.memory(file: "prefer-short-answers.md")?.body, "正文", "what the app holds does not change until the owner reloads")
    }

    func testAConflictWithNoMessageIsStaleToo() async throws {
        let (model, _) = try await loadedModel(commands: [StubReply(status: 409)])
        var draft = MemoryDraft(editing: try XCTUnwrap(model.memoryCatalog.memory(file: "prefer-short-answers.md")))
        draft.body = "新正文"
        let outcome = await model.saveMemory(draft)
        XCTAssertEqual(outcome, .stale)
    }

    func testABusyAlfredIsRefusedWithItsMessageAndTheListStays() async throws {
        let (model, _) = try await loadedModel(commands: [error(busyMessage, status: 409)])
        var draft = MemoryDraft(editing: try XCTUnwrap(model.memoryCatalog.memory(file: "prefer-short-answers.md")))
        draft.body = "新正文"

        let outcome = await model.saveMemory(draft)

        XCTAssertEqual(outcome, .refused(busyMessage))
        XCTAssertNil(model.actionFailure, "the form shows the message beside the draft")
        XCTAssertEqual(model.memoryCatalog.memories.count, 2)
    }

    func testAMemoryThatIsGoneLeavesTheListAndIsGone() async throws {
        let (model, _) = try await loadedModel(commands: [error("no memory prefer-short-answers.md", status: 404)])
        var draft = MemoryDraft(editing: try XCTUnwrap(model.memoryCatalog.memory(file: "prefer-short-answers.md")))
        draft.body = "新正文"

        let outcome = await model.saveMemory(draft)

        XCTAssertEqual(outcome, .gone)
        XCTAssertNil(model.memoryCatalog.memory(file: "prefer-short-answers.md"))
        XCTAssertNil(model.actionFailure)
    }

    func testAnyOtherRefusalCarriesTheServersMessage() async throws {
        let (model, _) = try makeModel(commands: [
            error("name: must be at most 80 characters", status: 400),
            error("memory is not wired in", status: 503),
            StubReply(failure: .notConnectedToInternet),
        ])
        var draft = MemoryDraft()
        draft.name = "名"

        let tooLong = await model.saveMemory(draft)
        XCTAssertEqual(tooLong, .refused("name: must be at most 80 characters"))
        let unwired = await model.saveMemory(draft)
        XCTAssertEqual(unwired, .refused("memory is not wired in"))
        let offline = await model.saveMemory(draft)
        guard case let .refused(message) = offline else { return XCTFail("a lost connection is a refusal") }
        XCTAssertFalse(message.isEmpty)
        XCTAssertNil(model.actionFailure)
    }

    func testARefusedSaveShowsTheAccessErrorOfTheStream() async throws {
        let (model, _) = try makeModel(commands: [StubReply(status: 403)])
        var draft = MemoryDraft()
        draft.name = "名"
        let outcome = await model.saveMemory(draft)
        guard case .refused = outcome else { return XCTFail("expected a refusal") }
        XCTAssertEqual(model.streamFailure, .forbidden)
    }

    // MARK: Deleting

    func testDeletingSendsTheFileAndVersionAndTheMemoryLeavesTheListAtOnce() async throws {
        let (model, server) = try await loadedModel(commands: [StubReply(chunks: [Data(#"{"deleted":true}"#.utf8)])])
        let memory = try XCTUnwrap(model.memoryCatalog.memory(file: "prefer-short-answers.md"))

        let outcome = await model.deleteMemory(memory)

        XCTAssertEqual(outcome, .deleted)
        XCTAssertEqual(model.memoryCatalog.memories.map(\.file), ["lives-in-shanghai.md"])
        XCTAssertEqual(try sentCommand(server), ["type": "memory.delete", "file": "prefer-short-answers.md", "version": "v1"] as NSDictionary)
        XCTAssertNil(model.actionFailure)
        XCTAssertEqual(server.requests(to: "/api/memories").count, 1, "a delete is not followed by a read")
    }

    func testDeletingAStaleVersionKeepsTheMemoryAndIsStale() async throws {
        let (model, _) = try await loadedModel(commands: [error(staleMessage, status: 409)])
        let memory = try XCTUnwrap(model.memoryCatalog.memory(file: "prefer-short-answers.md"))

        let outcome = await model.deleteMemory(memory)

        XCTAssertEqual(outcome, .stale)
        XCTAssertEqual(model.memoryCatalog.memories.count, 2)
        XCTAssertNil(model.actionFailure, "the list asks what to do instead")
    }

    func testDeletingWhileAlfredIsBusyShowsHisMessageInTheUsualAlertAndKeepsTheMemory() async throws {
        let (model, _) = try await loadedModel(commands: [error(busyMessage, status: 409)])
        let memory = try XCTUnwrap(model.memoryCatalog.memory(file: "prefer-short-answers.md"))

        let outcome = await model.deleteMemory(memory)

        XCTAssertEqual(outcome, .refused(busyMessage))
        XCTAssertEqual(model.actionFailure, busyMessage)
        XCTAssertEqual(model.memoryCatalog.memories.count, 2)
    }

    func testDeletingAMemoryThatIsGoneRemovesItWithoutAnAlert() async throws {
        let (model, _) = try await loadedModel(commands: [error("no memory prefer-short-answers.md", status: 404)])
        let memory = try XCTUnwrap(model.memoryCatalog.memory(file: "prefer-short-answers.md"))

        let outcome = await model.deleteMemory(memory)

        XCTAssertEqual(outcome, .gone)
        XCTAssertEqual(model.memoryCatalog.memories.map(\.file), ["lives-in-shanghai.md"])
        XCTAssertNil(model.actionFailure)
    }

    func testAFailedDeleteShowsTheUsualAlert() async throws {
        let (model, _) = try await loadedModel(commands: [StubReply(failure: .notConnectedToInternet)])
        let memory = try XCTUnwrap(model.memoryCatalog.memory(file: "prefer-short-answers.md"))

        let outcome = await model.deleteMemory(memory)

        guard case let .refused(message) = outcome else { return XCTFail("a lost connection is a refusal") }
        XCTAssertEqual(model.actionFailure, message)
        XCTAssertEqual(model.memoryCatalog.memories.count, 2)
    }

    // MARK: The rest of the app

    func testUnpairingForgetsTheMemories() async throws {
        let (model, _) = try await loadedModel(commands: [])
        XCTAssertFalse(model.memoryCatalog.memories.isEmpty)

        model.unpair()

        XCTAssertFalse(model.memoryCatalog.hasLoaded)
        XCTAssertTrue(model.memoryCatalog.memories.isEmpty)
    }
}
