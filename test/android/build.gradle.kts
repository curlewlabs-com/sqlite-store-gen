// Plugin versions for this build, the ones curlew-sqlite's own standalone build uses, so
// its module compiles here as it does there.

plugins {
    id("com.android.library") version "9.5.0" apply false
    // AGP's built-in Kotlin compiles both modules; the Kotlin Gradle plugin on the
    // classpath is what picks that compiler's version.
    id("org.jetbrains.kotlin.android") version "2.4.21" apply false
}

// The included module builds into this build's own directory, so a checkout of
// curlew-sqlite taken as source is only ever read.
project(":curlewsqlite") {
    layout.buildDirectory.set(rootProject.layout.buildDirectory.dir("curlewsqlite"))
}
