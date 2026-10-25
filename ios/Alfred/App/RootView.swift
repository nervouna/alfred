import AlfredKit
import SwiftUI

struct RootView: View {
    @Bindable var model: AppModel
    @Environment(\.scenePhase) private var scenePhase

    var body: some View {
        content
            .onChange(of: scenePhase, initial: true) { _, phase in
                switch phase {
                case .active: model.foreground()
                case .background: model.background()
                default: break
                }
            }
            .alert(model.actionFailure ?? "", isPresented: failureShown) {}
    }

    @ViewBuilder
    private var content: some View {
        if !model.isPaired {
            PairingView(model: model)
        } else if let failure = model.streamFailure {
            StreamFailureView(model: model, failure: failure)
        } else {
            TabView {
                Tab("对话", systemImage: "bubble.left") {
                    ChatView(model: model)
                }
                Tab("运行", systemImage: "gearshape.2") {
                    RunsView()
                }
                Tab("文档", systemImage: "doc.text") {
                    DocumentsView()
                }
            }
        }
    }

    private var failureShown: Binding<Bool> {
        Binding(
            get: { model.actionFailure != nil },
            set: { if !$0 { model.actionFailure = nil } }
        )
    }
}

/// What the app shows when the stream cannot go on: the device is no longer accepted, or Access refuses it.
private struct StreamFailureView: View {
    let model: AppModel
    let failure: AlfredError

    var body: some View {
        ContentUnavailableView {
            Label(title, systemImage: "exclamationmark.lock")
        } actions: {
            if failure == .forbidden {
                Button("重试") { model.retryStream() }
                    .buttonStyle(.borderedProminent)
            } else {
                Button("重新配对") { model.unpair() }
                    .buttonStyle(.borderedProminent)
            }
        }
    }

    private var title: String {
        failure == .forbidden ? "Cloudflare Access 拒绝了请求" : "这台设备已被撤销或未配对"
    }
}
