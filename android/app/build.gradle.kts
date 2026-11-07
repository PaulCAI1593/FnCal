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
        versionCode = 100
        versionName = "0.1.0"

        // 外壳版本与 FnCal 服务端版本无关；UA 里带的是壳版本。
        resValue("string", "fncal_shell_version", "0.1.0")
    }

    buildTypes {
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
