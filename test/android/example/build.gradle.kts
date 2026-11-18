// The generated storage layer as an Android library module, depending on curlew-sqlite's
// binding the way an app module would. prepare.sh writes the generated source.

plugins {
    id("com.android.library")
}

android {
    namespace = "org.example.reader.storage"
    compileSdk = 36

    defaultConfig {
        minSdk = 24
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_21
        targetCompatibility = JavaVersion.VERSION_21
    }

    sourceSets["main"].kotlin.directories.add("build/generated-sources/kotlin")
}

kotlin {
    compilerOptions {
        jvmTarget.set(org.jetbrains.kotlin.gradle.dsl.JvmTarget.JVM_21)
    }
}

dependencies {
    implementation(project(":curlewsqlite"))
}
