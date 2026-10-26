import AlfredKit
import XCTest

@testable import Alfred

@MainActor
final class ChatQuestionTests: XCTestCase {
    private static let format = ("报告用哪种格式？", ["短表格", "长文章"], false)
    private static let vendors = ("要对比哪些供应商？", ["Hetzner", "Vultr", "DigitalOcean"], true)

    /// A paired model following a stream that opens with the given frames, once the question has arrived.
    private func openQuestion(
        _ questions: [(String, [String], Bool)],
        commands: [StubReply] = [StubReply(status: 202)],
        more frames: [Data] = []
    ) async throws -> (ChatTestBed, QuestionAsked) {
        let opening = [questionAskedFrame(id: 1, questionId: "q-1", questions: questions)] + frames
        let bed = try makeChatTestBed(commands: commands, events: [.stream(opening)], test: self)
        bed.model.foreground()
        await eventually { bed.model.timeline.lastEventId == Int64(opening.count) }
        return (bed, try XCTUnwrap(bed.model.timeline.questions.first?.asked))
    }

    private func answers(of command: [String: Any]?) -> [String: String]? {
        command?["answers"] as? [String: String]
    }

    // MARK: Answering

    func testTappingTheOptionOfASingleQuestionSendsItsLabelAtOnce() async throws {
        let (bed, asked) = try await openQuestion([Self.format])

        await bed.model.answer(asked, choosing: "长文章")

        let command = try XCTUnwrap(bed.commands.first)
        XCTAssertEqual(bed.commands.count, 1)
        XCTAssertEqual(command["type"] as? String, "question.answer")
        XCTAssertEqual(command["questionId"] as? String, "q-1")
        XCTAssertEqual(answers(of: command), ["报告用哪种格式？": "长文章"])
        XCTAssertNil(bed.model.answerFailures["q-1"])
    }

    func testAMultiSelectQuestionJoinsTheLabelsWithACommaAndASpace() async throws {
        let (bed, asked) = try await openQuestion([Self.vendors])
        let question = asked.questions[0]

        var selection = QuestionSelection()
        XCTAssertNil(selection.answers(for: asked.questions), "nothing is picked yet")
        // Tapped out of order: the answer follows the order of the options.
        selection.toggle("Vultr", in: question)
        selection.toggle("Hetzner", in: question)
        XCTAssertEqual(selection.answers(for: asked.questions), ["要对比哪些供应商？": "Hetzner, Vultr"])
        await bed.model.answer(asked, selection: selection)

        XCTAssertEqual(answers(of: bed.commands.first), ["要对比哪些供应商？": "Hetzner, Vultr"])
        XCTAssertEqual(bed.commands.first?["questionId"] as? String, "q-1")
    }

    func testSeveralQuestionsAreAnsweredTogetherOnceEachHasAPick() async throws {
        let (bed, asked) = try await openQuestion([Self.format, Self.vendors])
        let questions = asked.questions

        var selection = QuestionSelection()
        selection.toggle("短表格", in: questions[0])
        XCTAssertNil(selection.answers(for: questions), "the second question has no pick")
        selection.toggle("DigitalOcean", in: questions[1])
        selection.toggle("Hetzner", in: questions[1])
        await bed.model.answer(asked, selection: selection)

        XCTAssertEqual(
            answers(of: bed.commands.first),
            ["报告用哪种格式？": "短表格", "要对比哪些供应商？": "Hetzner, DigitalOcean"]
        )
    }

    func testAPickOnASingleSelectQuestionReplacesTheLastAndTheSameTapUndoesIt() async throws {
        let question = QuestionAsked.sample(questions: [Self.format]).questions[0]
        var selection = QuestionSelection()
        selection.toggle("短表格", in: question)
        selection.toggle("长文章", in: question)
        XCTAssertFalse(selection.isPicked("短表格", in: question))
        XCTAssertTrue(selection.isPicked("长文章", in: question))
        XCTAssertEqual(selection.answers(for: [question]), ["报告用哪种格式？": "长文章"])

        selection.toggle("长文章", in: question)
        XCTAssertNil(selection.answers(for: [question]))
    }

    func testTheOneTapAnswerOnlyAppliesToOneSingleSelectQuestion() async throws {
        let (many, askedMany) = try await openQuestion([Self.format, Self.vendors])
        await many.model.answer(askedMany, choosing: "短表格")
        XCTAssertTrue(many.commands.isEmpty, "several questions are answered with 提交")

        let (multi, askedMulti) = try await openQuestion([Self.vendors])
        await multi.model.answer(askedMulti, choosing: "Hetzner")
        XCTAssertTrue(multi.commands.isEmpty, "a multi-select question is answered with 提交")

        let (unknown, askedUnknown) = try await openQuestion([Self.format])
        await unknown.model.answer(askedUnknown, choosing: "不存在的选项")
        XCTAssertTrue(unknown.commands.isEmpty, "a label that is not an option")
    }

    // MARK: Failures and progress

    func testAFailedAnswerShowsAnErrorAndLeavesTheQuestionOpen() async throws {
        let (bed, asked) = try await openQuestion(
            [Self.format],
            commands: [StubReply(failure: .networkConnectionLost), StubReply(status: 202)]
        )

        await bed.model.answer(asked, choosing: "短表格")

        XCTAssertNotNil(bed.model.answerFailures["q-1"])
        XCTAssertFalse(bed.model.answeringQuestions.contains("q-1"), "the card can be tapped again")
        XCTAssertEqual(bed.model.timeline.questions.first?.state, .open)

        await bed.model.answer(asked, choosing: "短表格")
        XCTAssertNil(bed.model.answerFailures["q-1"], "a new attempt clears the error")
        XCTAssertEqual(bed.commands.count, 2)
    }

    func testAQuestionThatIsNoLongerOpenGivesItsOwnError() async throws {
        let (bed, asked) = try await openQuestion(
            [Self.format],
            commands: [StubReply(status: 404, chunks: [Data(#"{"error":"no such question"}"#.utf8)])]
        )
        await bed.model.answer(asked, choosing: "短表格")
        let failure = try XCTUnwrap(bed.model.answerFailures["q-1"])
        XCTAssertTrue(failure.contains("不在等待"), failure)
    }

    func testARefusedDeviceOnAnAnswerShowsTheAccessFailure() async throws {
        let (bed, asked) = try await openQuestion([Self.format], commands: [StubReply(status: 401)])
        await bed.model.answer(asked, choosing: "短表格")
        XCTAssertEqual(bed.model.streamFailure, .unauthorized)
        XCTAssertNotNil(bed.model.answerFailures["q-1"])
    }

    func testAnAnswerOnItsWayDisablesTheCardUntilTheQuestionIsAnswered() async throws {
        let (bed, asked) = try await openQuestion([Self.format])

        await bed.model.answer(asked, choosing: "短表格")
        XCTAssertTrue(bed.model.answeringQuestions.contains("q-1"), "sent, waiting for the question.answered event")
        await bed.model.answer(asked, choosing: "长文章")
        XCTAssertEqual(bed.commands.count, 1, "a second tap while the first is on its way sends nothing")
    }

    // MARK: The timeline

    func testTheAnswerEventClosesTheCardWithTheAnswers() async throws {
        let answered = questionAnsweredFrame(id: 2, questionId: "q-1", answers: ["报告用哪种格式？": "短表格"])
        let (bed, asked) = try await openQuestion([Self.format], more: [answered])

        XCTAssertEqual(bed.model.timeline.questions.first?.state, .answered(["报告用哪种格式？": "短表格"]))
        XCTAssertFalse(bed.model.answeringQuestions.contains("q-1"))
        XCTAssertTrue(bed.model.timeline.openQuestions.isEmpty)
        _ = asked
    }

    func testARunEndingClosesItsQuestion() async throws {
        let (bed, _) = try await openQuestion([Self.format], more: [runFrame(id: 2, runId: "cccccc", status: "lost")])
        XCTAssertEqual(bed.model.timeline.questions.first?.state, .ended)
        XCTAssertTrue(bed.model.timeline.openQuestions.isEmpty)
    }

    func testAQuestionThatClosedForgetsItsAnswerFailureAndItsAnswerOnItsWay() async throws {
        let frames = [
            questionAskedFrame(id: 1, questionId: "q-1", questions: [Self.format]),
            runFrame(id: 2, runId: "cccccc", status: "lost"),
        ]
        let bed = try makeChatTestBed(commands: [StubReply(status: 500), StubReply(status: 202)], events: [.stream(frames)], test: self)
        let asked = QuestionAsked.sample(questions: [Self.format])

        // The answer goes out before the stream has delivered the question's end.
        await bed.model.answer(asked, choosing: "短表格")
        XCTAssertNotNil(bed.model.answerFailures["q-1"])
        await bed.model.answer(asked, choosing: "短表格")
        XCTAssertNil(bed.model.answerFailures["q-1"])
        XCTAssertTrue(bed.model.answeringQuestions.contains("q-1"))

        bed.model.foreground()
        await eventually { bed.model.timeline.lastEventId == 2 }
        XCTAssertEqual(bed.model.timeline.questions.first?.state, .ended)
        XCTAssertFalse(bed.model.answeringQuestions.contains("q-1"))
        XCTAssertNil(bed.model.answerFailures["q-1"])
    }
}

extension QuestionAsked {
    /// A question as the stream delivers it, for tests that need no stream.
    static func sample(questions: [(String, [String], Bool)]) -> QuestionAsked {
        let frame = questionAskedFrame(id: 1, questionId: "q-1", questions: questions)
        let text = String(decoding: frame, as: UTF8.self)
        let json = text.components(separatedBy: "data: ").last?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        let event = try? JSONDecoder().decode(Event.self, from: Data(json.utf8))
        if case let .questionAsked(asked)? = event?.payload { return asked }
        fatalError("the sample question does not decode")
    }
}
