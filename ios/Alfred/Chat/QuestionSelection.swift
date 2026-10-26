import AlfredKit

/// The options the owner has picked on a question card, before they are submitted.
struct QuestionSelection: Hashable {
    /// The picked labels by question text.
    private var picks: [String: Set<String>] = [:]

    func isPicked(_ label: String, in question: Question) -> Bool {
        picks[question.question]?.contains(label) ?? false
    }

    /// Picks an option, or takes the pick back. A single-select question holds one pick: another option replaces it.
    mutating func toggle(_ label: String, in question: Question) {
        var current = picks[question.question] ?? []
        if current.contains(label) {
            current.remove(label)
        } else if question.multiSelect {
            current.insert(label)
        } else {
            current = [label]
        }
        picks[question.question] = current.isEmpty ? nil : current
    }

    /// The answers to send, by question text: the picked label, or for a multi-select question the picked labels in
    /// the order of the options, joined with `, `. `nil` until every question has a pick.
    func answers(for questions: [Question]) -> [String: String]? {
        var answers: [String: String] = [:]
        for question in questions {
            guard let picked = picks[question.question], !picked.isEmpty else { return nil }
            answers[question.question] = question.options.map(\.label).filter(picked.contains).joined(separator: ", ")
        }
        return answers
    }
}
