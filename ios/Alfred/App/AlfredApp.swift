import SwiftUI

@main
struct AlfredApp: App {
    @State private var model = AppModel.live()

    var body: some Scene {
        WindowGroup {
            RootView(model: model)
        }
    }
}
