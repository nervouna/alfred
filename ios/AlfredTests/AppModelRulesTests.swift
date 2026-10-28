import AlfredKit
import XCTest

@testable import Alfred

/// The app's view of ALFRED.md: read from `GET /api/rules`, replaced by `rules.save`.
@MainActor
final class AppModelRulesTests: XCTestCase {
    /// A paired model on a fake server. `reads` answers `GET /api/rules` in turn, `commands` answers `POST /api/commands`.
    private func makeModel(reads: [StubReply] = [], commands: [StubReply] = []) throws -> (AppModel, StubServer) {
        let readScript = ReplyScript(reads.isEmpty ? [StubReply(status: 500)] : reads)
        let commandScript = ReplyScript(commands.isEmpty ? [StubReply(status: 500)] : commands)
        let server = StubServer { request in
            switch request.url?.path ?? "" {
            case "/api/rules": return readScript.next()
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

    private func rules(_ text: String, version: String = String(repeating: "a", count: 64)) throws -> StubReply {
        StubReply(chunks: [try TestData.rulesJSON(text: text, version: version)])
    }

    private func error(_ message: String, status: Int) -> StubReply {
        StubReply(status: status, chunks: [Data(#"{"error":"\#(message)"}"#.utf8)])
    }

    // MARK: Reading

    func testReadingKeepsTheTextItsVersionAndTheLimit() async throws {
        let (model, server) = try makeModel(reads: [try rules("# 规则\n", version: String(repeating: "b", count: 64))])
        XCTAssertNil(model.rules)

        let read = await model.refreshRules()

        XCTAssertEqual(model.rules?.text, "# 规则\n")
        XCTAssertEqual(model.rules?.version, String(repeating: "b", count: 64))
        XCTAssertEqual(model.rules?.maxBytes, 8192)
        XCTAssertEqual(read, model.rules, "the read is handed back too")
        XCTAssertFalse(model.isLoadingRules)
        XCTAssertNil(model.actionFailure)
        XCTAssertEqual(server.requests(to: "/api/rules").count, 1)
    }

    func testAReadReplacesWhatWasKept() async throws {
        let (model, _) = try makeModel(reads: [try rules("# 旧\n"), try rules("# 新\n", version: String(repeating: "c", count: 64))])
        await model.refreshRules()
        await model.refreshRules()
        XCTAssertEqual(model.rules?.text, "# 新\n")
        XCTAssertEqual(model.rules?.version, String(repeating: "c", count: 64))
    }

    func testAFailedReadShowsTheUsualAlertAndKeepsWhatWasRead() async throws {
        let (model, _) = try makeModel(reads: [try rules("# 规则\n"), error("too long to edit here", status: 413)])
        await model.refreshRules()

        let read = await model.refreshRules()

        XCTAssertNil(read)
        XCTAssertEqual(model.actionFailure, "服务器返回 413：too long to edit here")
        XCTAssertEqual(model.rules?.text, "# 规则\n")
        XCTAssertFalse(model.isLoadingRules)
    }

    func testAFailedFirstReadLeavesNoRules() async throws {
        let (model, _) = try makeModel(reads: [error("bad gateway", status: 502)])
        await model.refreshRules()
        XCTAssertNil(model.rules)
        XCTAssertEqual(model.actionFailure, "服务器返回 502：bad gateway")
        XCTAssertFalse(model.isLoadingRules)
    }

    func testARefusedReadShowsTheAccessErrorOfTheStream() async throws {
        let (model, _) = try makeModel(reads: [StubReply(status: 401)])
        await model.refreshRules()
        XCTAssertEqual(model.streamFailure, .unauthorized)
    }

    func testAReadWhileUnpairedDoesNothing() async throws {
        let (model, server) = try makeModel(reads: [try rules("# 规则\n")])
        model.unpair()
        let read = await model.refreshRules()
        XCTAssertNil(read)
        XCTAssertNil(model.rules)
        XCTAssertEqual(server.requests(to: "/api/rules").count, 0)
    }

    // MARK: Saving

    func testSavingSendsTheTextAgainstTheVersionAndKeepsTheNewRules() async throws {
        let newVersion = String(repeating: "d", count: 64)
        let (model, server) = try makeModel(
            reads: [try rules("# 旧\n")],
            commands: [try rules("# 新\n", version: newVersion)]
        )
        await model.refreshRules()
        let old = try XCTUnwrap(model.rules)

        let outcome = await model.saveRules(text: "# 新\n", version: old.version)

        guard case let .saved(saved) = outcome else { return XCTFail("the save did not work: \(outcome)") }
        XCTAssertEqual(saved.text, "# 新\n")
        XCTAssertEqual(saved.version, newVersion)
        XCTAssertEqual(model.rules, saved, "the page shows the saved text without reading again")
        let sent = try XCTUnwrap(server.requests(to: "/api/commands").first?.chatCommand)
        XCTAssertEqual(sent as? [String: String], ["type": "rules.save", "text": "# 新\n", "version": old.version])
        XCTAssertNil(model.actionFailure)
        XCTAssertEqual(server.requests(to: "/api/rules").count, 1, "a save is not followed by a read")
    }

    func testAStaleVersionIsAConflictAndNoAlert() async throws {
        let (model, _) = try makeModel(
            reads: [try rules("# 旧\n")],
            commands: [error("version: not the current version of ALFRED.md", status: 409)]
        )
        await model.refreshRules()

        let outcome = await model.saveRules(text: "# 新\n", version: "stale")

        XCTAssertEqual(outcome, .conflict)
        XCTAssertNil(model.actionFailure, "the editor asks what to do instead")
        XCTAssertEqual(model.rules?.text, "# 旧\n", "what the app holds does not change until the owner reloads")
    }

    func testAnyOtherRefusalShowsTheServersMessageInTheUsualAlert() async throws {
        let (model, _) = try makeModel(
            reads: [try rules("# 旧\n")],
            commands: [error("text: must be at most 8192 bytes", status: 400), error("rules are not wired in", status: 503)]
        )
        await model.refreshRules()

        let tooLong = await model.saveRules(text: "x", version: "v")
        XCTAssertEqual(tooLong, .failed)
        XCTAssertEqual(model.actionFailure, "text: must be at most 8192 bytes")
        XCTAssertEqual(model.rules?.text, "# 旧\n")

        model.actionFailure = nil
        let unwired = await model.saveRules(text: "x", version: "v")
        XCTAssertEqual(unwired, .failed)
        XCTAssertEqual(model.actionFailure, "rules are not wired in")
    }

    func testANetworkFailureOfASaveIsAFailureWithTheUsualAlert() async throws {
        let (model, _) = try makeModel(commands: [StubReply(failure: .notConnectedToInternet)])
        let outcome = await model.saveRules(text: "x", version: "v")
        XCTAssertEqual(outcome, .failed)
        XCTAssertNotNil(model.actionFailure)
    }

    func testARefusedSaveShowsTheAccessErrorOfTheStream() async throws {
        let (model, _) = try makeModel(commands: [StubReply(status: 403)])
        let outcome = await model.saveRules(text: "x", version: "v")
        XCTAssertEqual(outcome, .failed)
        XCTAssertEqual(model.streamFailure, .forbidden)
    }

    // MARK: The rest of the app

    func testUnpairingForgetsTheRules() async throws {
        let (model, _) = try makeModel(reads: [try rules("# 规则\n")])
        await model.refreshRules()
        XCTAssertNotNil(model.rules)

        model.unpair()

        XCTAssertNil(model.rules)
    }
}
