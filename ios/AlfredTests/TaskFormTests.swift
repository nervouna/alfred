import AlfredKit
import XCTest

@testable import Alfred

final class TaskFormTests: XCTestCase {
    private let now = Date(timeIntervalSince1970: 1_792_000_000)

    private func filled(_ edit: (inout TaskForm) -> Void = { _ in }) -> TaskForm {
        var form = TaskForm(now: now)
        form.title = "每日简报"
        form.brief = "写一份两行的简报"
        edit(&form)
        return form
    }

    private func editing(
        schedule: [String: Any] = ["kind": "daily", "time": "08:00"],
        status: String = "active",
        model: String = "sonnet",
        budgetUsd: Double = 2
    ) throws -> TaskForm {
        TaskForm(editing: try TestData.task(
            "aaaaaa", title: "每日简报", brief: "写一份两行的简报", status: status, schedule: schedule, model: model, budgetUsd: budgetUsd
        ))
    }

    // MARK: A new task

    func testANewFormStartsWithDailyAtEightSonnetAndTwoDollars() {
        let form = TaskForm(now: now)
        XCTAssertEqual(form.kind, .daily)
        XCTAssertEqual(form.schedule, .daily(time: TimeOfDay(hour: 8, minute: 0)))
        XCTAssertEqual(form.model, .sonnet)
        XCTAssertEqual(form.budgetText, "2")
        XCTAssertFalse(form.isEditing)
    }

    func testANewFormsOneTimeRunDefaultsToTheFutureOnAWholeMinute() {
        let form = TaskForm(now: now)
        XCTAssertGreaterThan(form.onceAt, now.addingTimeInterval(3000))
        XCTAssertEqual(form.onceAt.timeIntervalSinceReferenceDate.truncatingRemainder(dividingBy: 60), 0)
    }

    func testAFilledFormHasNoProblems() {
        XCTAssertEqual(filled().problems(now: now), [])
    }

    // MARK: Validation

    func testABlankTitleOrBriefIsAProblem() {
        XCTAssertEqual(filled { $0.title = "" }.problems(now: now), [.blankTitle])
        XCTAssertEqual(filled { $0.title = "  \n " }.problems(now: now), [.blankTitle])
        XCTAssertEqual(filled { $0.brief = "" }.problems(now: now), [.blankBrief])
        XCTAssertEqual(filled { $0.brief = " \n" }.problems(now: now), [.blankBrief])
        XCTAssertEqual(TaskForm(now: now).problems(now: now), [.blankTitle, .blankBrief])
    }

    func testAWeeklyScheduleNeedsAWeekday() {
        let form = filled {
            $0.kind = .weekly
            $0.days = []
        }
        XCTAssertEqual(form.problems(now: now), [.noWeekday])
        // The weekdays of a schedule the form is not set to are not checked.
        XCTAssertEqual(filled { $0.days = [] }.problems(now: now), [])
    }

    func testAOneTimeRunInThePastIsAProblem() {
        let past = filled {
            $0.kind = .once
            $0.onceAt = now.addingTimeInterval(-60)
        }
        XCTAssertEqual(past.problems(now: now), [.oncePassed])
        let future = filled {
            $0.kind = .once
            $0.onceAt = now.addingTimeInterval(60)
        }
        XCTAssertEqual(future.problems(now: now), [])
    }

    func testTheCapMustBeAboveZeroAndAtMostTwenty() {
        for text in ["", "abc", "0", "-1", "20.01", "21", "1e9"] {
            XCTAssertEqual(filled { $0.budgetText = text }.problems(now: now), [.badBudget], text)
        }
        for text in ["0.3", "0.30", "2", "20", " 5 ", "0,3"] {
            XCTAssertEqual(filled { $0.budgetText = text }.problems(now: now), [], text)
        }
        XCTAssertEqual(filled { $0.budgetText = "0,3" }.budget, 0.3, "a decimal comma reads as a point")
    }

    func testEveryProblemIsListedWithItsMessage() {
        let form = filled {
            $0.title = ""
            $0.kind = .weekly
            $0.days = []
            $0.budgetText = "0"
        }
        XCTAssertEqual(form.problems(now: now), [.blankTitle, .noWeekday, .badBudget])
        XCTAssertEqual(TaskForm.Problem.blankTitle.message, "请填写标题")
        XCTAssertEqual(TaskForm.Problem.blankBrief.message, "请填写任务说明")
        XCTAssertEqual(TaskForm.Problem.noWeekday.message, "请至少选一个星期")
        XCTAssertEqual(TaskForm.Problem.oncePassed.message, "执行时间已过，请选一个之后的时间")
        XCTAssertEqual(TaskForm.Problem.badBudget.message, "上限需大于 0，且不超过 20 美元")
    }

    // MARK: Creating

    func testTheDraftCarriesWhatTheFormShows() {
        let form = filled {
            $0.model = .haiku
            $0.budgetText = "0.30"
        }
        XCTAssertEqual(form.draft(), TaskDraft(
            title: "每日简报", brief: "写一份两行的简报", schedule: .daily(time: TimeOfDay(hour: 8, minute: 0)),
            model: .haiku, budgetUsd: 0.3
        ))
    }

    func testTheDraftTrimsTheTitleAndBrief() {
        let form = filled {
            $0.title = "  每日简报\n"
            $0.brief = "\n写一份简报  \n"
        }
        XCTAssertEqual(form.draft().title, "每日简报")
        XCTAssertEqual(form.draft().brief, "写一份简报")
    }

    func testEachScheduleKindMakesItsSchedule() {
        XCTAssertEqual(filled { $0.time = TimeOfDay(hour: 7, minute: 45) }.draft().schedule, .daily(time: TimeOfDay(hour: 7, minute: 45)))
        XCTAssertEqual(
            filled {
                $0.kind = .weekly
                $0.days = [5, 1, 3]
                $0.time = TimeOfDay(hour: 9, minute: 30)
            }.draft().schedule,
            .weekly(days: [1, 3, 5], time: TimeOfDay(hour: 9, minute: 30)),
            "the contract wants the weekdays in ascending order"
        )
        XCTAssertEqual(filled { $0.kind = .interval; $0.hours = 12 }.draft().schedule, .interval(hours: 12))
        let at = now.addingTimeInterval(7200)
        XCTAssertEqual(filled { $0.kind = .once; $0.onceAt = at }.draft().schedule, .once(at: at))
    }

    // MARK: Editing

    func testAnEditFormShowsTheTask() throws {
        let form = try TaskForm(editing: TestData.task(
            "aaaaaa", title: "周报", brief: "每周总结", schedule: ["kind": "weekly", "days": [1, 3, 5], "time": "08:30"],
            model: "opus", budgetUsd: 0.25
        ))
        XCTAssertTrue(form.isEditing)
        XCTAssertEqual(form.title, "周报")
        XCTAssertEqual(form.brief, "每周总结")
        XCTAssertEqual(form.kind, .weekly)
        XCTAssertEqual(form.days, [1, 3, 5])
        XCTAssertEqual(form.time, TimeOfDay(hour: 8, minute: 30))
        XCTAssertEqual(form.model, .opus)
        XCTAssertEqual(form.budgetText, "0.25")
    }

    func testAnEditFormShowsAnIntervalAndAOneTimeRun() throws {
        let interval = try editing(schedule: ["kind": "interval", "hours": 6])
        XCTAssertEqual(interval.kind, .interval)
        XCTAssertEqual(interval.hours, 6)
        let once = try editing(schedule: ["kind": "once", "at": "2026-12-01T01:00:00Z"])
        XCTAssertEqual(once.kind, .once)
        XCTAssertEqual(once.onceAt, try Date.ISO8601FormatStyle().parse("2026-12-01T01:00:00Z"))
    }

    func testNothingChangedSendsNothing() throws {
        XCTAssertNil(try editing().changes())
        XCTAssertNil(try editing(schedule: ["kind": "weekly", "days": [1, 3, 5], "time": "08:30"]).changes())
        XCTAssertNil(try editing(schedule: ["kind": "once", "at": "2026-12-01T01:00:30Z"]).changes(), "a one-time run keeps its seconds")
    }

    func testOnlyTheChangedFieldsAreSent() throws {
        var form = try editing()
        form.title = "新标题"
        XCTAssertEqual(form.changes(), TaskChanges(title: "新标题"))

        form = try editing()
        form.brief = "新说明"
        XCTAssertEqual(form.changes(), TaskChanges(brief: "新说明"))

        form = try editing()
        form.model = .haiku
        XCTAssertEqual(form.changes(), TaskChanges(model: .haiku))

        form = try editing()
        form.budgetText = "0.5"
        XCTAssertEqual(form.changes(), TaskChanges(budgetUsd: 0.5))

        form = try editing()
        form.time = TimeOfDay(hour: 9, minute: 0)
        XCTAssertEqual(form.changes(), TaskChanges(schedule: .daily(time: TimeOfDay(hour: 9, minute: 0))))

        form = try editing()
        form.title = "新标题"
        form.model = .opus
        XCTAssertEqual(form.changes(), TaskChanges(title: "新标题", model: .opus))
    }

    func testChangingTheScheduleKindSendsTheNewSchedule() throws {
        var form = try editing()
        form.kind = .interval
        form.hours = 4
        XCTAssertEqual(form.changes(), TaskChanges(schedule: .interval(hours: 4)))
        // Back to what it was: nothing to send.
        form.kind = .daily
        XCTAssertNil(form.changes())
    }

    func testTheSameWeekdaysInAnotherOrderAreNotAChange() throws {
        var form = try editing(schedule: ["kind": "weekly", "days": [1, 3, 5], "time": "08:30"])
        form.days = [5, 3, 1]
        XCTAssertNil(form.changes())
        form.days = [1, 3]
        XCTAssertEqual(form.changes(), TaskChanges(schedule: .weekly(days: [1, 3], time: TimeOfDay(hour: 8, minute: 30))))
    }

    func testTheCapAsTypedIsComparedAsANumber() throws {
        var form = try editing(budgetUsd: 0.3)
        form.budgetText = "0.30"
        XCTAssertNil(form.changes())
    }

    func testTextAroundATitleIsNotAChange() throws {
        var form = try editing()
        form.title = "  每日简报 "
        XCTAssertNil(form.changes())
    }

    func testAnEditsStatusIsNeverSent() throws {
        // Pausing, resuming and ending are the detail's own actions; the form never sends a status.
        var form = try editing(status: "paused")
        form.title = "新标题"
        XCTAssertNil(form.changes()?.status)
    }

    func testOnlyChangedFieldsGoOnTheWire() throws {
        var form = try editing()
        form.model = .haiku
        form.budgetText = "0.3"
        let changes = try XCTUnwrap(form.changes())
        let data = try JSONEncoder().encode(Command.taskUpdate(taskId: "aaaaaa", changes: changes))
        let object = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
        XCTAssertEqual(Set(object.keys), ["type", "taskId", "model", "budgetUsd"])
        XCTAssertEqual(object["model"] as? String, "haiku")
        XCTAssertEqual(object["budgetUsd"] as? Double, 0.3)
    }

    func testAnEditChecksTheScheduleOnlyWhenItChanged() throws {
        // A paused one-time task whose time has passed can still be renamed: the schedule is not sent.
        let past = ["kind": "once", "at": "2026-10-01T01:00:00Z"]
        var form = try editing(schedule: past, status: "paused")
        form.title = "新标题"
        XCTAssertEqual(form.problems(now: now), [])
        // Setting another time that has passed is still refused.
        form.onceAt = now.addingTimeInterval(-3600)
        XCTAssertEqual(form.problems(now: now), [.oncePassed])
        // And so is a blank title on an edit.
        form = try editing()
        form.title = " "
        XCTAssertEqual(form.problems(now: now), [.blankTitle])
    }

    func testTheModelOfATaskIsKeptEvenWhenThisAppDoesNotKnowIt() throws {
        let form = try editing(model: "gamma")
        XCTAssertEqual(form.model, TaskModel(rawValue: "gamma"))
        XCTAssertTrue(form.models.contains(TaskModel(rawValue: "gamma")))
        XCTAssertEqual(TaskForm(now: now).models, [.sonnet, .opus, .haiku])
        XCTAssertNil(form.changes())
    }

    // MARK: Time of day

    func testATimeOfDayMakesTheSameWallClockAsADateAndBack() {
        for time in [TimeOfDay(hour: 0, minute: 0), TimeOfDay(hour: 8, minute: 5), TimeOfDay(hour: 23, minute: 59)] {
            XCTAssertEqual(TaskForm.timeOfDay(of: TaskForm.date(of: time)), time)
        }
    }

    // MARK: What the server says

    func testARejectedCommandShowsTheServersOwnMessage() {
        XCTAssertEqual(LoadFailure.commandMessage(for: AlfredError.http(status: 400, message: "that time has passed")), "that time has passed")
        XCTAssertEqual(LoadFailure.commandMessage(for: AlfredError.http(status: 404, message: "no task aaaaaa")), "no task aaaaaa")
        XCTAssertEqual(LoadFailure.commandMessage(for: AlfredError.http(status: 503, message: nil)), "服务器返回 503")
        XCTAssertEqual(LoadFailure.commandMessage(for: AlfredError.unauthorized), LoadFailure.message(for: AlfredError.unauthorized))
    }
}
