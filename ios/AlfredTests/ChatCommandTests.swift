import AlfredKit
import UIKit
import XCTest

@testable import Alfred

@MainActor
final class ChatCommandTests: XCTestCase {
    private var commands: [ChatCommand] {
        ChatCommand.menu.flatMap { $0 }
    }

    // MARK: The text and the menu

    func testEachCommandSendsTheTextTheOwnerWouldType() {
        XCTAssertEqual(ChatCommand.new.text, "/new")
        XCTAssertEqual(ChatCommand.resume.text, "/resume")
        XCTAssertEqual(ChatCommand.status.text, "/status")
        XCTAssertEqual(ChatCommand.memory.text, "/memory")
        XCTAssertEqual(ChatCommand.model(.sonnet).text, "/model sonnet")
        XCTAssertEqual(ChatCommand.model(.opus).text, "/model opus")
        XCTAssertEqual(ChatCommand.model(.haiku).text, "/model haiku")
    }

    func testTheMenuIsBuiltInThisOrderAndGrouping() {
        XCTAssertEqual(ChatCommand.menu, [
            [.new, .resume],
            [.model(.sonnet), .model(.opus), .model(.haiku)],
            [.status, .memory],
        ])
        XCTAssertEqual(commands.map(\.title), ["新会话", "切回上一个会话", "Sonnet", "Opus", "Haiku", "状态", "长期记忆"])
    }

    func testEveryCommandHasASymbolThatExists() {
        for command in commands {
            XCTAssertNotNil(UIImage(systemName: command.symbol), "no SF Symbol \(command.symbol) for \(command.title)")
        }
    }

    // MARK: Which commands need an idle chat

    func testOnlyNewAndResumeNeedAnIdleChat() {
        XCTAssertEqual(commands.filter(\.needsIdleChat), [.new, .resume])
    }

    /// `TaskModel` has no list of its keys, so this names its three: a model added to it needs a line in `ChatCommand.menu`
    /// and here.
    func testTheModelCommandsCoverEveryModelKey() {
        let models = commands.compactMap { command -> TaskModel? in
            if case let .model(model) = command { model } else { nil }
        }
        XCTAssertEqual(models, [TaskModel.sonnet, TaskModel.opus, TaskModel.haiku])
    }

    // MARK: Choosing

    /// Choosing a command sends its text as the owner's message, and the draft being typed in the composer stays.
    func testChoosingACommandSendsItsTextAndLeavesTheDraft() async throws {
        let bed = try makeChatTestBed(test: self)
        bed.model.composerText = "还没发的话"

        await ChatView.choose(.status, in: bed.model)

        XCTAssertEqual(bed.commands.count, 1)
        XCTAssertEqual(bed.commands.first?["type"] as? String, "message.send")
        XCTAssertEqual(bed.commands.first?["text"] as? String, "/status")
        XCTAssertEqual(bed.model.composerText, "还没发的话")
    }
}
