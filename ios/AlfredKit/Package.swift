// swift-tools-version: 6.0

import PackageDescription

let package = Package(
    name: "AlfredKit",
    platforms: [.iOS(.v18), .macOS(.v15)],
    products: [
        .library(name: "AlfredKit", targets: ["AlfredKit"]),
    ],
    targets: [
        .target(name: "AlfredKit"),
        .testTarget(name: "AlfredKitTests", dependencies: ["AlfredKit"]),
    ]
)
