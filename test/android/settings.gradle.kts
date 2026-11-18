// Compiles the Kotlin the generator emits for example/spec.json against curlew-sqlite's
// Android library, taken as source the way a consumer takes it: its curlewsqlite module
// included from a checkout, named by -PcurlewSqliteDir.

pluginManagement {
    repositories {
        google()
        mavenCentral()
        gradlePluginPortal()
    }
}

dependencyResolutionManagement {
    repositoriesMode.set(RepositoriesMode.FAIL_ON_PROJECT_REPOS)
    repositories {
        google()
        mavenCentral()
    }
}

rootProject.name = "sqlite-store-gen-android"

val curlewSqliteDir =
    providers.gradleProperty("curlewSqliteDir").orNull
        ?: throw GradleException("pass -PcurlewSqliteDir=<curlew-sqlite checkout>")
include(":curlewsqlite")
project(":curlewsqlite").projectDir = file("$curlewSqliteDir/android/curlewsqlite")
include(":example")
