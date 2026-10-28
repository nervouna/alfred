import AlfredKit

/// The slash commands the chat's menu offers as items. Choosing one sends its text as the owner's message, the same text
/// the owner would have typed, so Alfred answers it in the conversation as it does any command.
enum ChatCommand: Hashable, Sendable {
    case new
    case resume
    case model(TaskModel)
    case status
    case memory

    /// The menu's groups, top to bottom; each is one section of the menu. The models are the group the menu shows as a
    /// submenu.
    static let menu: [[ChatCommand]] = [
        [.new, .resume],
        [.model(.sonnet), .model(.opus), .model(.haiku)],
        [.status, .memory],
    ]

    /// The menu item's title.
    var title: String {
        switch self {
        case .new: "新会话"
        case .resume: "切回上一个会话"
        case let .model(model):
            switch model {
            case .sonnet: "Sonnet"
            case .opus: "Opus"
            case .haiku: "Haiku"
            default: model.rawValue
            }
        case .status: "状态"
        case .memory: "长期记忆"
        }
    }

    /// The menu item's SF Symbol.
    var symbol: String {
        switch self {
        case .new: "square.and.pencil"
        case .resume: "arrow.uturn.backward"
        case .model: "cpu"
        case .status: "info.circle"
        case .memory: "brain.head.profile"
        }
    }

    /// Whether the command is a model, which the menu offers as a submenu.
    var isModel: Bool {
        switch self {
        case .model: true
        case .new, .resume, .status, .memory: false
        }
    }

    /// The text sent as the owner's message.
    var text: String {
        switch self {
        case .new: "/new"
        case .resume: "/resume"
        case let .model(model): "/model \(model.rawValue)"
        case .status: "/status"
        case .memory: "/memory"
        }
    }

    /// Whether the command starts or switches a session, which the server refuses while a run is going: the menu holds
    /// it off until the chat's run has ended. The server still says so if it is sent anyway.
    var needsIdleChat: Bool {
        switch self {
        case .new, .resume: true
        case .model, .status, .memory: false
        }
    }
}
