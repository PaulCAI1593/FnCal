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
        versionCode = 202
        versionName = "0.2.2"

        // 外壳版本与 FnCal 服务端版本无关；UA 里带的是壳版本。
        resValue("string", "fncal_shell_version", "0.2.2")
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
            isMinifyEnabled = false
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
}
