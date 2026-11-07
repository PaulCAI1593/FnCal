/**
 * FnCal 安卓外壳 v0.1.0
 *
 * 本目录由 `gradle/actions/setup-gradle` 在 CI 里用 Gradle 8.7 构建；
 * 本机没有 Android SDK / Gradle，也没有 gradle-wrapper.jar，见 README.md。
 */
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

rootProject.name = "FnCalAndroid"
include(":app")
