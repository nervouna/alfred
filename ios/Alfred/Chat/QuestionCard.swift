import AlfredKit
import SwiftUI

/// A question Alfred asked, where it was asked. While it is open its options can be tapped; afterwards it keeps
/// the answers, or says it was cancelled or ended with its run.
struct QuestionCard: View {
    let model: AppModel
    let record: QuestionRecord
    @State private var selection = QuestionSelection()

    private var asked: QuestionAsked { record.asked }
    private var isOpen: Bool { record.state == .open }
    private var isAnswering: Bool { model.answeringQuestions.contains(record.id) }

    /// One single-select question is answered by the tap itself; any other needs 提交.
    private var answersOnTap: Bool {
        asked.questions.count == 1 && asked.questions.first?.multiSelect == false
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            ForEach(asked.questions, id: \.question) { question in
                VStack(alignment: .leading, spacing: 8) {
                    Text(question.header)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                    Text(MessageText.attributed(question.question))
                        .font(.body.weight(.medium))
                        .fixedSize(horizontal: false, vertical: true)
                    switch record.state {
                    case .open:
                        ForEach(question.options, id: \.label) { option in
                            OptionButton(
                                option: option,
                                picks: answersOnTap ? nil : (selection.isPicked(option.label, in: question), question.multiSelect)
                            ) {
                                if answersOnTap {
                                    Task { await model.answer(asked, choosing: option.label) }
                                } else {
                                    selection.toggle(option.label, in: question)
                                }
                            }
                            .disabled(isAnswering)
                        }
                    case let .answered(answers):
                        HStack(alignment: .firstTextBaseline, spacing: 6) {
                            Image(systemName: "checkmark")
                                .accessibilityHidden(true)
                            Text(answer(to: question, in: answers))
                                .accessibilityIdentifier("question.answered")
                        }
                        .font(.subheadline.weight(.medium))
                        .foregroundStyle(Color.accentColor)
                    case .cancelled, .ended:
                        EmptyView()
                    }
                }
            }
            footer
        }
        .padding(12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color(.secondarySystemBackground), in: RoundedRectangle(cornerRadius: 16))
        .overlay(RoundedRectangle(cornerRadius: 16).stroke(Color.accentColor.opacity(isOpen ? 0.6 : 0), lineWidth: 1))
        .opacity(record.state == .cancelled || record.state == .ended ? 0.7 : 1)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("question.card." + record.id)
    }

    @ViewBuilder
    private var footer: some View {
        switch record.state {
        case .open:
            if let failure = model.answerFailures[record.id] {
                Text(failure)
                    .font(.footnote)
                    .foregroundStyle(.red)
                    .accessibilityIdentifier("question.error")
            }
            if !answersOnTap {
                HStack {
                    Spacer()
                    if isAnswering {
                        ProgressView()
                            .controlSize(.small)
                    }
                    Button("提交") {
                        Task { await model.answer(asked, selection: selection) }
                    }
                    .buttonStyle(.borderedProminent)
                    .disabled(selection.answers(for: asked.questions) == nil || isAnswering)
                    .accessibilityIdentifier("question.submit")
                }
            }
        case .answered:
            EmptyView()
        case .cancelled:
            Text("已取消")
                .font(.footnote)
                .foregroundStyle(.secondary)
                .accessibilityIdentifier("question.cancelled")
        case .ended:
            Text("已结束")
                .font(.footnote)
                .foregroundStyle(.secondary)
                .accessibilityIdentifier("question.ended")
        }
    }

    /// What the owner answered to a question. Free text answers every open question under its own text.
    private func answer(to question: Question, in answers: [String: String]) -> String {
        answers[question.question] ?? answers.values.sorted().joined(separator: "\n")
    }
}

/// One option of an open question: its label with its description under it. When the card is answered with 提交,
/// the option shows whether it is picked, as a checkbox for a multi-select question and a radio button for the rest.
private struct OptionButton: View {
    let option: QuestionOption
    /// `nil` when a tap answers at once; otherwise whether the option is picked, and whether several may be.
    let picks: (isPicked: Bool, multiple: Bool)?
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            HStack(alignment: .top, spacing: 10) {
                if let picks {
                    Image(systemName: symbol(for: picks))
                        .foregroundStyle(picks.isPicked ? Color.accentColor : .secondary)
                }
                VStack(alignment: .leading, spacing: 2) {
                    Text(option.label)
                        .font(.subheadline.weight(.medium))
                        .foregroundStyle(.primary)
                    if !option.description.isEmpty {
                        Text(option.description)
                            .font(.caption)
                            .foregroundStyle(.secondary)
                            .multilineTextAlignment(.leading)
                    }
                }
                Spacer(minLength: 0)
            }
            .padding(10)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(
                picks?.isPicked == true ? Color.accentColor.opacity(0.14) : Color(.tertiarySystemBackground),
                in: RoundedRectangle(cornerRadius: 10)
            )
            .contentShape(RoundedRectangle(cornerRadius: 10))
        }
        .buttonStyle(.plain)
        .accessibilityLabel(option.label)
        .accessibilityHint(option.description)
        .accessibilityAddTraits(picks?.isPicked == true ? .isSelected : [])
        .accessibilityIdentifier("question.option")
    }

    private func symbol(for picks: (isPicked: Bool, multiple: Bool)) -> String {
        switch (picks.multiple, picks.isPicked) {
        case (true, true): "checkmark.square.fill"
        case (true, false): "square"
        case (false, true): "largecircle.fill.circle"
        case (false, false): "circle"
        }
    }
}
