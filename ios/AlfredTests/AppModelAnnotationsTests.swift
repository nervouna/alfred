import AlfredKit
import XCTest

@testable import Alfred

/// Submitting a document's drafts as a revision, making a draft from an annotation that went back, and undoing a revision.
@MainActor
final class AppModelAnnotationsTests: XCTestCase {
    private let v1 = TestData.commit(1)
    private let v2 = TestData.commit(2)
    private let v3 = TestData.commit(3)
    private let body = "本周豆价小幅上涨，进口量明显下降。预计下周价格保持稳定。"

    /// A paired model on a fake server. `commands` answers `POST /api/commands` in turn and `details` answers
    /// `GET /api/documents/aaaaaa`.
    private func makeModel(commands: [StubReply] = [StubReply(status: 202)], details: [StubReply] = []) throws -> (AppModel, StubServer) {
        let commandScript = ReplyScript(commands)
        let detailScript = ReplyScript(details.isEmpty ? [StubReply(status: 404)] : details)
        let server = StubServer { request in
            switch request.url?.path ?? "" {
            case "/api/commands": return commandScript.next()
            case "/api/documents/aaaaaa": return detailScript.next()
            case "/api/events": return .stream()
            default: return StubReply(status: 404)
            }
        }
        let model = AppModel(
            store: InMemoryCredentialStore(try server.credentials()),
            session: server.session,
            openStream: { _, _ in AsyncStream { _ in } }
        )
        addTeardownBlock { @MainActor in
            model.background()
            withExtendedLifetime(server) {}
        }
        return (model, server)
    }

    private func passage(_ quote: String, prefix: String = "", suffix: String = "") -> AnnotationTarget {
        .passage(quote: quote, prefix: prefix, suffix: suffix)
    }

    private func commands(_ server: StubServer) -> [[String: Any]] {
        server.requests(to: "/api/commands").compactMap(\.chatCommand)
    }

    private func detailReply(version: String) throws -> StubReply {
        StubReply(chunks: [try TestData.detailJSON(
            document: TestData.documentObject("aaaaaa", version: version),
            versions: [TestData.versionObject(version, reason: "changed"), TestData.versionObject(v1)]
        )])
    }

    /// Three drafts on the document: a passage that fits `body`, one that does not, and a comment on the whole document.
    private func writeDrafts(_ model: AppModel) {
        model.annotationDrafts.add(documentId: "aaaaaa", version: v1, target: passage("进口量", prefix: "旧的上下文"), comment: "写具体")
        model.annotationDrafts.add(documentId: "aaaaaa", version: v1, target: passage("已经删掉的话"), comment: "不会发出去")
        model.annotationDrafts.add(documentId: "aaaaaa", version: v1, target: .document, comment: "整篇再正式些")
    }

    // MARK: 202

    func testAcceptedDraftsGoAsOneRevisionInTheOrderTheyWereWritten() async throws {
        let accepted = try TestData.revisionAccepted(annotations: [
            TestData.annotationJSON("g7e4xr", version: v1, target: TestData.passageTarget("进口量", prefix: "上涨，", suffix: "明显下降。预计下周价格保持稳定。"), comment: "写具体"),
            TestData.annotationJSON("h8f5ys", version: v1, comment: "整篇再正式些"),
        ])
        let (model, server) = try makeModel(commands: [StubReply(status: 202, chunks: [accepted])])
        writeDrafts(model)

        let outcome = await model.submitAnnotations(documentId: "aaaaaa", version: v1, text: AnchorText(text: body))

        guard case let .accepted(runId, annotations) = outcome else { return XCTFail("not accepted: \(outcome)") }
        XCTAssertEqual(runId, "s2d8kp")
        XCTAssertEqual(annotations.map(\.id), ["g7e4xr", "h8f5ys"])
        let sent = try XCTUnwrap(commands(server).first)
        XCTAssertEqual(commands(server).count, 1)
        XCTAssertEqual(sent["type"] as? String, "document.revise")
        XCTAssertEqual(sent["documentId"] as? String, "aaaaaa")
        XCTAssertEqual(sent["version"] as? String, v1)
        let batch = try XCTUnwrap(sent["annotations"] as? [[String: Any]])
        XCTAssertEqual(batch.count, 2, "the passage that does not fit is not sent")
        XCTAssertEqual(batch[0]["comment"] as? String, "写具体")
        let target = try XCTUnwrap(batch[0]["target"] as? [String: String])
        XCTAssertEqual(target, ["kind": "passage", "quote": "进口量", "prefix": "本周豆价小幅上涨，", "suffix": "明显下降。预计下周价格保持稳定。"],
                       "the passage goes with the context it has in the text of the version")
        XCTAssertEqual(batch[1]["comment"] as? String, "整篇再正式些")
        XCTAssertEqual(batch[1]["target"] as? [String: String], ["kind": "document"])
    }

    func testAcceptedDraftsAreRemovedAndTheAnnotationsShowAsSubmitted() async throws {
        let accepted = try TestData.revisionAccepted(annotations: [
            TestData.annotationJSON("g7e4xr", version: v1, target: TestData.passageTarget("进口量"), comment: "写具体"),
            TestData.annotationJSON("h8f5ys", version: v1, comment: "整篇再正式些"),
        ])
        let (model, _) = try makeModel(commands: [StubReply(status: 202, chunks: [accepted])])
        writeDrafts(model)

        _ = await model.submitAnnotations(documentId: "aaaaaa", version: v1, text: AnchorText(text: body))

        XCTAssertEqual(model.annotationDrafts.drafts(of: "aaaaaa").map(\.comment), ["不会发出去"], "only the draft that did not fit stays")
        XCTAssertEqual(model.documentCatalog.annotations(of: "aaaaaa").map(\.state), [.submitted, .submitted])
        XCTAssertEqual(Set(model.documentCatalog.annotations(of: "aaaaaa").map(\.id)), ["g7e4xr", "h8f5ys"])
    }

    func testNothingIsSentWhenNoDraftFits() async throws {
        let (model, server) = try makeModel()
        model.annotationDrafts.add(documentId: "aaaaaa", version: v1, target: passage("已经删掉的话"), comment: "不会发出去")

        let none = await model.submitAnnotations(documentId: "aaaaaa", version: v1, text: AnchorText(text: body))
        XCTAssertEqual(none, .nothingToSend)

        let (empty, emptyServer) = try makeModel()
        let nothing = await empty.submitAnnotations(documentId: "aaaaaa", version: v1, text: nil)
        XCTAssertEqual(nothing, .nothingToSend)
        XCTAssertEqual(commands(server).count + commands(emptyServer).count, 0, "no request went out")
        XCTAssertEqual(model.annotationDrafts.drafts(of: "aaaaaa").count, 1)
    }

    // MARK: 409

    func testAConflictReadsTheDetailAgainAndKeepsTheDrafts() async throws {
        let (model, server) = try makeModel(
            commands: [StubReply(status: 409, chunks: [Data(#"{"error":"the document has a newer version"}"#.utf8)])],
            details: [try detailReply(version: v2)]
        )
        writeDrafts(model)
        let before = model.annotationDrafts.drafts(of: "aaaaaa")

        let outcome = await model.submitAnnotations(documentId: "aaaaaa", version: v1, text: AnchorText(text: body))

        guard case let .conflict(message, detail) = outcome else { return XCTFail("not a conflict: \(outcome)") }
        XCTAssertEqual(message, "the document has a newer version", "the server's own message")
        XCTAssertEqual(detail?.document.version, v2, "the detail that was read again")
        XCTAssertEqual(server.requests(to: "/api/documents/aaaaaa").count, 1)
        XCTAssertEqual(model.annotationDrafts.drafts(of: "aaaaaa"), before, "the drafts stay")
        XCTAssertEqual(model.documentCatalog.document(id: "aaaaaa")?.version, v2, "the document follows its new version")
        XCTAssertEqual(outcome.failureMessage, message)
    }

    func testAConflictWhoseDetailCannotBeReadStillKeepsTheDraftsAndSaysWhy() async throws {
        let (model, _) = try makeModel(
            commands: [StubReply(status: 409, chunks: [Data(#"{"error":"a revision is already running"}"#.utf8)])],
            details: [StubReply(status: 500)]
        )
        writeDrafts(model)

        let outcome = await model.submitAnnotations(documentId: "aaaaaa", version: v1, text: AnchorText(text: body))

        guard case let .conflict(message, detail) = outcome else { return XCTFail("not a conflict: \(outcome)") }
        XCTAssertEqual(message, "a revision is already running")
        XCTAssertNil(detail)
        XCTAssertEqual(model.annotationDrafts.drafts(of: "aaaaaa").count, 3)
    }

    func testAConflictThatSaysNothingGetsTheUsualWords() async throws {
        let (model, _) = try makeModel(commands: [StubReply(status: 409)], details: [try detailReply(version: v2)])
        writeDrafts(model)

        let outcome = await model.submitAnnotations(documentId: "aaaaaa", version: v1, text: AnchorText(text: body))

        XCTAssertEqual(outcome.failureMessage, "文档已经有了新的版本，请核对后再提交")
    }

    // MARK: 400 and the network

    func testARefusalKeepsTheDraftsAndShowsTheServersMessage() async throws {
        let (model, _) = try makeModel(commands: [StubReply(status: 400, chunks: [Data(#"{"error":"annotations.0.comment: must not be blank"}"#.utf8)])])
        writeDrafts(model)

        let outcome = await model.submitAnnotations(documentId: "aaaaaa", version: v1, text: AnchorText(text: body))

        XCTAssertEqual(outcome, .rejected(message: "annotations.0.comment: must not be blank"))
        XCTAssertEqual(model.annotationDrafts.drafts(of: "aaaaaa").count, 3, "the drafts stay")
        XCTAssertEqual(model.documentCatalog.annotations(of: "aaaaaa"), [])
    }

    func testANetworkErrorKeepsTheDraftsAndShowsTheError() async throws {
        let (model, _) = try makeModel(commands: [StubReply(failure: .notConnectedToInternet)])
        writeDrafts(model)

        let outcome = await model.submitAnnotations(documentId: "aaaaaa", version: v1, text: AnchorText(text: body))

        guard case let .failed(message) = outcome else { return XCTFail("not a failure: \(outcome)") }
        XCTAssertEqual(message, URLError(.notConnectedToInternet).localizedDescription)
        XCTAssertEqual(model.annotationDrafts.drafts(of: "aaaaaa").count, 3)
        XCTAssertNil(model.streamFailure)
    }

    func testARevokedDeviceKeepsTheDraftsAndIsAnAccessError() async throws {
        let (model, _) = try makeModel(commands: [StubReply(status: 401)])
        writeDrafts(model)

        let outcome = await model.submitAnnotations(documentId: "aaaaaa", version: v1, text: AnchorText(text: body))

        XCTAssertNotNil(outcome.failureMessage)
        XCTAssertEqual(model.annotationDrafts.drafts(of: "aaaaaa").count, 3)
        XCTAssertEqual(model.streamFailure, .unauthorized)
    }

    // MARK: Editing again

    func testAReturnedPassageThatStillFitsBecomesADraftOnTheCurrentVersion() throws {
        let (model, _) = try makeModel()
        let returned = try TestData.annotation(
            "ret1", version: v1, target: TestData.passageTarget("进口量", prefix: "旧的上下文"), comment: "写具体", state: "returned", returnReason: "undone"
        )

        let draft = model.reedit(returned, current: v2, text: AnchorText(text: body))

        XCTAssertEqual(draft.version, v2)
        XCTAssertEqual(draft.comment, "写具体")
        XCTAssertEqual(draft.origin, "ret1")
        XCTAssertEqual(draft.target, passage("进口量", prefix: "本周豆价小幅上涨，", suffix: "明显下降。预计下周价格保持稳定。"), "re-anchored on the current text")
        XCTAssertEqual(model.annotationDrafts.drafts(of: "aaaaaa"), [draft])
    }

    func testAReturnedPassageThatNoLongerFitsKeepsItsContextAndItsVersion() throws {
        let (model, _) = try makeModel()
        let returned = try TestData.annotation("ret1", version: v1, target: TestData.passageTarget("已经删掉的话", prefix: "旧"), state: "returned", returnReason: "failed")

        let draft = model.reedit(returned, current: v2, text: AnchorText(text: body))

        XCTAssertEqual(draft.version, v1)
        XCTAssertEqual(draft.target, passage("已经删掉的话", prefix: "旧"))
        let sections = AnnotationPresentation.sections(drafts: [draft], annotations: [], fits: { AnchorText(text: self.body).locate($0) != nil || $0 == .document })
        XCTAssertEqual(sections.map(\.kind), [.misfit], "it lands in 已失配")
    }

    func testAReturnedCommentOnTheWholeDocumentBecomesADraftOnTheCurrentVersion() throws {
        let (model, _) = try makeModel()
        let returned = try TestData.annotation("ret1", version: v1, comment: "整篇再正式些", state: "returned", returnReason: "stopped")

        let draft = model.reedit(returned, current: v2, text: nil)

        XCTAssertEqual(draft.target, .document)
        XCTAssertEqual(draft.version, v2)
    }

    func testAReturnedPassageWaitsForTheTextWhenItIsNotKnown() throws {
        let (model, _) = try makeModel()
        let returned = try TestData.annotation("ret1", version: v1, target: TestData.passageTarget("进口量"), state: "returned", returnReason: "undone")

        let draft = model.reedit(returned, current: v2, text: nil)

        XCTAssertEqual(draft.version, v1, "it is anchored when the current version is shown")
        model.annotationDrafts.reanchor(documentId: "aaaaaa", to: v2, in: AnchorText(text: body))
        XCTAssertEqual(model.annotationDrafts.list.draft(id: draft.id)?.version, v2)
    }

    // MARK: Undo

    func testUndoingARevisionListsTheNewVersionAtOnce() async throws {
        let undone = try TestData.undone(document: TestData.documentObject("aaaaaa", version: v3, updatedAt: "2026-10-27T03:00:00.000Z"))
        let (model, server) = try makeModel(commands: [StubReply(chunks: [undone])])

        let outcome = await model.undoRevision(documentId: "aaaaaa", runId: "s2d8kp")

        guard case let .undone(document) = outcome else { return XCTFail("not undone: \(outcome)") }
        XCTAssertEqual(document.version, v3)
        XCTAssertEqual(model.documentCatalog.document(id: "aaaaaa")?.version, v3)
        let sent = try XCTUnwrap(commands(server).first)
        XCTAssertEqual(sent["type"] as? String, "document.undo")
        XCTAssertEqual(sent["documentId"] as? String, "aaaaaa")
        XCTAssertEqual(sent["runId"] as? String, "s2d8kp")
    }

    func testAnUndoTheServerRefusesShowsItsMessage() async throws {
        let (model, _) = try makeModel(commands: [StubReply(status: 409, chunks: [Data(#"{"error":"another run changed the files since"}"#.utf8)])])

        let outcome = await model.undoRevision(documentId: "aaaaaa", runId: "s2d8kp")

        XCTAssertEqual(outcome, .refused("another run changed the files since"))
        XCTAssertNil(model.documentCatalog.document(id: "aaaaaa"))
    }

    // MARK: Stopping

    func testTheBannersStopSendsRunStopForTheRevisionRun() async throws {
        let (model, server) = try makeModel()

        await model.stop(runId: "s2d8kp")

        let sent = try XCTUnwrap(commands(server).first)
        XCTAssertEqual(sent["type"] as? String, "run.stop")
        XCTAssertEqual(sent["runId"] as? String, "s2d8kp")
    }
}
