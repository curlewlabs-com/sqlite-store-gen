// swift-tools-version:6.0
// Compiles the Swift the generator emits for example/spec.json against the SQLite engine
// curlew-sqlite pins, and runs storage tests on it. prepare.sh fills Sources/ from a
// curlew-sqlite checkout and the generator; nothing under Sources/ is committed.

import Foundation
import PackageDescription

// The engine's compile definitions come from the pin file prepare.sh copies beside this
// manifest, so this build compiles the amalgamation exactly as the pod does.
let pinURL = URL(fileURLWithPath: #filePath)
    .deletingLastPathComponent()
    .appendingPathComponent("Sources/CurlewSQLite/CurlewSQLite.lock.json")
let pin = try JSONSerialization.jsonObject(with: Data(contentsOf: pinURL)) as! [String: Any]
let definitions = (pin["compile_definitions"] as! [String]).map { definition -> CSetting in
    let parts = definition.split(separator: "=", maxSplits: 1).map(String.init)
    return .define(parts[0], to: parts.count > 1 ? parts[1] : nil)
}

let package = Package(
    name: "ExampleStore",
    platforms: [.macOS(.v15)],
    targets: [
        .target(
            name: "CurlewSQLite",
            exclude: ["CurlewSQLite.lock.json"],
            cSettings: definitions
        ),
        .target(name: "ExampleStore", dependencies: ["CurlewSQLite"]),
        .testTarget(name: "ExampleStoreTests", dependencies: ["ExampleStore", "CurlewSQLite"]),
    ]
)
