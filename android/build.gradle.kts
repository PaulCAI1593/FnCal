// 根构建脚本：只声明插件版本，具体 apply 在各模块。
plugins {
    id("com.android.application") version "8.5.2" apply false
    id("org.jetbrains.kotlin.android") version "1.9.24" apply false
}
