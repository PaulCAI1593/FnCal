plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "com.paulcai1593.fncal.app"
    compileSdk = 34

    defaultConfig {
        applicationId = "com.paulcai1593.fncal.app"
        minSdk = 24
        targetSdk = 34
        versionCode = 307
        versionName = "0.3.7"

        // 外壳版本与 FnCal 服务端版本无关；UA 里带的是壳版本。
        resValue("string", "fncal_shell_version", "0.3.7")

        // 0.3.7（包体瘦身）：只保留中英两种语言资源。AGP 8.5.2 用新的
        // resourceConfigurations；resConfigs 已弃用，别用。
        resourceConfigurations += listOf("zh", "en")
    }

    signingConfigs {
        // 0.2.1（§S1）：固定测试签名。根因是 CI 每次重建 ~/.android/debug.keystore，
        // 私钥随机 → 新包不能覆盖旧包。这里提交一把测试 keystore，CI 每次都用它。
        create("test") {
            storeFile = file("../keystore/fncal-test.keystore")
            storePassword = "fncal-test-2026"
            keyAlias = "fncal"
            keyPassword = "fncal-test-2026"
        }
    }

    buildTypes {
        debug {
            // 测试包也用固定签名；正式签名以后另建 release 配置。
            signingConfig = signingConfigs.getByName("test")
        }
        release {
            // 0.3.7（包体瘦身）：发布包改走 release，签名仍用固定测试 keystore，
            // 保证 0.3.6 → 0.3.7 直接覆盖升级、证书指纹不变。
            signingConfig = signingConfigs.getByName("test")
            // R8 裁剪已跟踪不到的代码并压缩 dex；资源同样收缩（未引用的 res 移除）。
            isMinifyEnabled = true
            isShrinkResources = true
            proguardFiles(
                getDefaultProguardFile("proguard-android-optimize.txt"),
                "proguard-rules.pro",
            )
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    kotlinOptions {
        jvmTarget = "17"
    }

    buildFeatures {
        buildConfig = true
    }
}

dependencies {
    implementation("androidx.core:core-ktx:1.13.1")
    implementation("androidx.appcompat:appcompat:1.7.0")
    // 0.3.0（§A2）：桌面卡片每 30 分钟刷新；WorkManager 是系统推荐的周期任务方案。
    implementation("androidx.work:work-runtime-ktx:2.9.0")
}
