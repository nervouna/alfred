import SwiftUI

struct RootView: View {
    var body: some View {
        TabView {
            Tab("对话", systemImage: "bubble.left") {
                ChatView()
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
