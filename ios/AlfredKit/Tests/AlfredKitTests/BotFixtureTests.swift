import AlfredKit
import Foundation
import XCTest

final class BotFixtureTests: XCTestCase {
    private func decode<T: Decodable>(_ type: T.Type, _ name: String) throws -> T {
        try JSONDecoder().decode(type, from: Data(contentsOf: Fixtures.directory.appending(path: name)))
    }

    func testTheBotListHoldsBotX() throws {
        let list = try decode(BotList.self, "responses/bot-list.json")
        let bot = try XCTUnwrap(list.bots.first)
        XCTAssertEqual(list.bots.count, 1)
        XCTAssertEqual(bot.id, "x")
        XCTAssertEqual(bot.name, "X")
        XCTAssertEqual(bot.model, .haiku)
        XCTAssertEqual(bot.runBudgetUsd, 1)
        XCTAssertEqual(bot.tools, ["WebFetch", "WebSearch"])
        XCTAssertTrue(bot.createdAt <= bot.updatedAt)
        XCTAssertFalse(Bot.isAlfred(bot.id))
        XCTAssertEqual(try decode(BotList.self, "responses/bot-list-empty.json").bots, [])
    }

    func testTheBotUpdatedEventCarriesTheWholeBot() throws {
        let event = try decode(Event.self, "events/bot-updated.json")
        guard case let .botUpdated(bot) = event.payload else { return XCTFail("expected bot.updated, got \(event.payload)") }
        XCTAssertEqual(bot, try decode(BotList.self, "responses/bot-list.json").bots[0])
    }

    func testTheObjectsOfBotXCarryItsId() throws {
        guard case let .messageCreated(message) = try decode(Event.self, "events/message-created-bot-in.json").payload else { return XCTFail("message") }
        XCTAssertEqual(message.botId, "x")
        guard case let .runUpdated(run) = try decode(Event.self, "events/run-updated-bot.json").payload else { return XCTFail("run") }
        XCTAssertEqual(run.botId, "x")
        guard case let .taskUpdated(task) = try decode(Event.self, "events/task-updated-bot.json").payload else { return XCTFail("task") }
        XCTAssertEqual(task.botId, "x")
        guard case let .questionAsked(asked) = try decode(Event.self, "events/question-asked-bot.json").payload else { return XCTFail("question") }
        XCTAssertEqual(asked.botId, "x")
        guard case let .messageDelta(_, _, _, botId) = try decode(LiveEvent.self, "live/message-delta-bot.json").payload else { return XCTFail("delta") }
        XCTAssertEqual(botId, "x")
    }

    func testObjectsWithoutABotIdBelongToAlfred() throws {
        guard case let .messageCreated(message) = try decode(Event.self, "events/message-created-app-in.json").payload else { return XCTFail("message") }
        XCTAssertNil(message.botId)
        XCTAssertTrue(Bot.isAlfred(message.botId))
        XCTAssertTrue(Bot.isAlfred("alfred"))
    }
}
