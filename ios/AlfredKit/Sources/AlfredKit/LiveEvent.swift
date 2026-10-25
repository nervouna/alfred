import Foundation

/// A live event: a piece of a reply or a step of a run, as it happens. Live events are never stored,
/// so they carry no `id`. A `type` this client does not know decodes to `.unknown`.
public struct LiveEvent: Decodable, Hashable, Sendable {
    public enum Payload: Hashable, Sendable {
        /// A piece of assistant text. The deltas of one `streamId` concatenate into one reply, and the
        /// latest stream of a run is shown as that run's draft until an outbound message replaces it.
        case messageDelta(runId: String, streamId: String, text: String)
        case runStep(runId: String, step: Step)
        /// An event type this client does not know. Its `data` is not decoded.
        case unknown(type: String)
    }

    public let at: Date
    public let payload: Payload

    private enum CodingKeys: String, CodingKey {
        case at, type, data
    }

    public init(from decoder: any Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        at = try container.decodeTimestamp(forKey: .at)
        let type = try container.decode(String.self, forKey: .type)
        switch type {
        case "message.delta":
            let delta = try container.decode(MessageDeltaData.self, forKey: .data)
            payload = .messageDelta(runId: delta.runId, streamId: delta.streamId, text: delta.text)
        case "run.step":
            let data = try container.decode(RunStepData.self, forKey: .data)
            payload = .runStep(runId: data.runId, step: data.step)
        default:
            payload = .unknown(type: type)
        }
    }
}

private struct MessageDeltaData: Decodable {
    let runId: String
    let streamId: String
    let text: String
}

private struct RunStepData: Decodable {
    let runId: String
    let step: Step
}

/// One frame of Alfred's stream. A frame with an SSE `id` is a stored `Event`; a frame without one is a `LiveEvent`.
public enum StreamEvent: Hashable, Sendable {
    case event(Event)
    case live(LiveEvent)
}

extension StreamEvent: Decodable {
    /// Events and live events are told apart by the `id` key, which only stored events have.
    public init(from decoder: any Decoder) throws {
        let keys = try decoder.container(keyedBy: IDKey.self)
        if keys.contains(.id) {
            self = .event(try Event(from: decoder))
        } else {
            self = .live(try LiveEvent(from: decoder))
        }
    }

    private enum IDKey: String, CodingKey {
        case id
    }
}
