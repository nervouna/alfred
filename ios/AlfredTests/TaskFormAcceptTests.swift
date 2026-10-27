import AlfredKit
import XCTest

@testable import Alfred

/// The task form in its accept mode: filled in from an idea, with 立即 for a one-off idea.
final class TaskFormAcceptTests: XCTestCase {
    private let now = Date(timeIntervalSince1970: 1_792_000_000)

    private func oneOff(estimate: Double = 0.35, model: String = "sonnet") throws -> AlfredIdea {
        try TestData.idea("aaaaaa", title: "对比带宽", brief: "查三家的带宽。", model: model, estimateUsd: estimate)
    }

    private func recurring(_ schedule: [String: Any], estimate: Double = 0.2) throws -> AlfredIdea {
        try TestData.idea("bbbbbb", title: "追踪价格", brief: "每周看一次。", kind: "recurring", schedule: schedule, model: "haiku", estimateUsd: estimate)
    }

    // MARK: Filling in

    func testTheFormShowsTheIdeasTitleBriefAndModel() throws {
        let form = TaskForm(accepting: try oneOff(model: "opus"), now: now)
        XCTAssertEqual(form.title, "对比带宽")
        XCTAssertEqual(form.brief, "查三家的带宽。")
        XCTAssertEqual(form.model, .opus)
        XCTAssertTrue(form.isAccepting)
        XCTAssertFalse(form.isEditing)
        XCTAssertEqual(form.problems(now: now), [])
    }

    // MARK: One-off ideas

    func testAOneOffIdeaStartsOnNowAndSendsNoSchedule() throws {
        let form = TaskForm(accepting: try oneOff(), now: now)
        XCTAssertEqual(form.kind, .now)
        XCTAssertEqual(form.kind.title, "立即")
        XCTAssertNil(form.acceptance().schedule)
    }

    func testNowIsAtTheHeadOfTheKindsAndTheOrdinaryKindsStayAvailable() throws {
        let form = TaskForm(accepting: try oneOff(), now: now)
        XCTAssertEqual(form.kinds, [.now, .daily, .weekly, .interval, .once])
    }

    func testAOneOffIdeaCanStillBeScheduled() throws {
        var form = TaskForm(accepting: try oneOff(), now: now)
        form.kind = .daily
        form.time = TimeOfDay(hour: 7, minute: 30)
        XCTAssertEqual(form.acceptance().schedule, .daily(time: TimeOfDay(hour: 7, minute: 30)))
        form.kind = .interval
        form.hours = 12
        XCTAssertEqual(form.acceptance().schedule, .interval(hours: 12))
        let at = now.addingTimeInterval(7200)
        form.kind = .once
        form.onceAt = at
        XCTAssertEqual(form.acceptance().schedule, .once(at: at))
        form.kind = .now
        XCTAssertNil(form.acceptance().schedule, "back to 立即: nothing is sent")
    }

    func testNowIsNotAOneTimeRunInThePast() throws {
        var form = TaskForm(accepting: try oneOff(), now: now)
        form.onceAt = now.addingTimeInterval(-3600)
        XCTAssertEqual(form.problems(now: now), [], "the one-time fields are not sent for 立即")
        form.kind = .once
        XCTAssertEqual(form.problems(now: now), [.oncePassed])
    }

    // MARK: Recurring ideas

    func testARecurringIdeasScheduleFillsTheScheduleFields() throws {
        let weekly = TaskForm(accepting: try recurring(["kind": "weekly", "days": [1, 3], "time": "09:15"]), now: now)
        XCTAssertEqual(weekly.kind, .weekly)
        XCTAssertEqual(weekly.days, [1, 3])
        XCTAssertEqual(weekly.time, TimeOfDay(hour: 9, minute: 15))
        XCTAssertEqual(weekly.acceptance().schedule, .weekly(days: [1, 3], time: TimeOfDay(hour: 9, minute: 15)))

        let daily = TaskForm(accepting: try recurring(["kind": "daily", "time": "08:00"]), now: now)
        XCTAssertEqual(daily.kind, .daily)
        XCTAssertEqual(daily.acceptance().schedule, .daily(time: TimeOfDay(hour: 8, minute: 0)))

        let interval = TaskForm(accepting: try recurring(["kind": "interval", "hours": 6]), now: now)
        XCTAssertEqual(interval.kind, .interval)
        XCTAssertEqual(interval.hours, 6)
        XCTAssertEqual(interval.acceptance().schedule, .interval(hours: 6))
    }

    func testARecurringIdeaDoesNotOfferNow() throws {
        let form = TaskForm(accepting: try recurring(["kind": "daily", "time": "08:00"]), now: now)
        XCTAssertEqual(form.kinds, [.daily, .weekly, .interval, .once])
    }

    func testARecurringIdeasScheduleCanBeChangedBeforeAccepting() throws {
        var form = TaskForm(accepting: try recurring(["kind": "weekly", "days": [1], "time": "09:00"]), now: now)
        form.days = [1, 2, 3]
        form.time = TimeOfDay(hour: 10, minute: 0)
        XCTAssertEqual(form.acceptance().schedule, .weekly(days: [1, 2, 3], time: TimeOfDay(hour: 10, minute: 0)))
    }

    // MARK: The cap

    func testTheCapDefaultsToTwoDollarsForASmallEstimate() throws {
        XCTAssertEqual(TaskForm(accepting: try oneOff(estimate: 0.30), now: now).budgetText, "2")
        XCTAssertEqual(TaskForm(accepting: try oneOff(estimate: 0.30), now: now).acceptance().budgetUsd, 2)
        XCTAssertEqual(TaskForm(accepting: try oneOff(estimate: 1), now: now).budgetText, "2", "twice the estimate is not more than two")
        XCTAssertEqual(TaskForm(accepting: try oneOff(estimate: 0), now: now).budgetText, "2")
    }

    func testTheCapIsTwiceTheEstimateRoundedUpToAWholeDollarWhenThatIsMore() throws {
        let form = TaskForm(accepting: try oneOff(estimate: 1.40), now: now)
        XCTAssertEqual(form.budgetText, "3")
        XCTAssertEqual(form.acceptance().budgetUsd, 3)
        XCTAssertEqual(TaskForm(accepting: try oneOff(estimate: 1.01), now: now).budgetText, "3")
        XCTAssertEqual(TaskForm(accepting: try oneOff(estimate: 2.5), now: now).budgetText, "5")
    }

    func testTheCapIsAtMostTwentyDollars() throws {
        let form = TaskForm(accepting: try oneOff(estimate: 15), now: now)
        XCTAssertEqual(form.budgetText, "20")
        XCTAssertEqual(form.acceptance().budgetUsd, 20)
        XCTAssertEqual(TaskForm(accepting: try oneOff(estimate: 10), now: now).budgetText, "20")
        XCTAssertEqual(TaskForm(accepting: try oneOff(estimate: 20), now: now).budgetText, "20")
        XCTAssertEqual(form.problems(now: now), [])
    }

    func testTheCapStillHasToBeValid() throws {
        var form = TaskForm(accepting: try oneOff(), now: now)
        form.budgetText = "21"
        XCTAssertEqual(form.problems(now: now), [.badBudget])
        form.budgetText = "0"
        XCTAssertEqual(form.problems(now: now), [.badBudget])
    }

    // MARK: What is sent

    func testTheAcceptanceHoldsTheFormAsTheOwnerLeftIt() throws {
        var form = TaskForm(accepting: try oneOff(), now: now)
        form.title = "  新标题\n"
        form.brief = "\n写两行笔记。 "
        form.model = .haiku
        form.budgetText = "0,3"
        XCTAssertEqual(
            form.acceptance(),
            IdeaAcceptance(title: "新标题", brief: "写两行笔记。", schedule: nil, model: .haiku, budgetUsd: 0.3)
        )
    }

    func testABlankTitleOrBriefIsStillAProblem() throws {
        var form = TaskForm(accepting: try oneOff(), now: now)
        form.title = " "
        form.brief = ""
        XCTAssertEqual(form.problems(now: now), [.blankTitle, .blankBrief])
    }

    // MARK: The other modes

    func testTheOtherFormsDoNotOfferNow() throws {
        XCTAssertEqual(TaskForm(now: now).kinds, [.daily, .weekly, .interval, .once])
        XCTAssertFalse(TaskForm(now: now).isAccepting)
        let task = try TestData.task("tttttt")
        XCTAssertEqual(TaskForm(editing: task).kinds, [.daily, .weekly, .interval, .once])
        XCTAssertFalse(TaskForm(editing: task).isAccepting)
    }

    func testANewFormStillStartsDailyAndEditingStillSendsOnlyWhatChanged() throws {
        XCTAssertEqual(TaskForm(now: now).kind, .daily)
        var form = try TaskForm(editing: TestData.task("tttttt"))
        form.budgetText = "5"
        XCTAssertEqual(form.changes(), TaskChanges(budgetUsd: 5))
    }
}
