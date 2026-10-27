import java.util.Properties

plugins {
    alias(libs.plugins.android.application)
    alias(libs.plugins.compose.compiler)
}

// 版本号与签名由 ChatDSH 接管：版本来自 mobile/version.properties，签名用仓库自有的
// release 密钥。上游原文件用 debug 签名并在 build.gradle.kts 里硬写版本号。
val versionProps = Properties().apply {
    rootProject.file("version.properties").inputStream().use { load(it) }
}
val versionNameValue = versionProps.getProperty("VERSION_NAME")
    ?: throw GradleException("mobile/version.properties 缺少 VERSION_NAME")
val versionCodeValue = versionProps.getProperty("VERSION_CODE")
    ?: throw GradleException("mobile/version.properties 缺少 VERSION_CODE")
val keystorePath = System.getenv("CHATDSH_ANDROID_KEYSTORE")

android {
    namespace = "com.clarklevis.dsh.android"
    compileSdk = 36

    defaultConfig {
        applicationId = "com.clarklevis.dsh.android"
        minSdk = 24
        targetSdk = 36
        versionCode = versionCodeValue.toInt()
        versionName = versionNameValue
        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
    }

    signingConfigs {
        // 只在构建脚本给出密钥时创建；缺失时 release 构建在打包阶段直接失败，
        // 不退回 debug 密钥，避免发出无法覆盖安装的包。
        if (keystorePath != null) {
            create("chatdshRelease") {
                storeFile = file(keystorePath)
                storePassword = System.getenv("CHATDSH_ANDROID_STORE_PASSWORD") // gitleaks:allow
                    ?: throw GradleException("设置了 CHATDSH_ANDROID_KEYSTORE 但缺少 CHATDSH_ANDROID_STORE_PASSWORD")
                keyAlias = System.getenv("CHATDSH_ANDROID_KEY_ALIAS")
                    ?: throw GradleException("设置了 CHATDSH_ANDROID_KEYSTORE 但缺少 CHATDSH_ANDROID_KEY_ALIAS")
                keyPassword = System.getenv("CHATDSH_ANDROID_KEY_PASSWORD") // gitleaks:allow
                    ?: throw GradleException("设置了 CHATDSH_ANDROID_KEYSTORE 但缺少 CHATDSH_ANDROID_KEY_PASSWORD")
                enableV1Signing = true
                enableV2Signing = true
                enableV3Signing = true
            }
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            proguardFiles(
                getDefaultProguardFile("proguard-android-optimize.txt"),
                "proguard-rules.pro"
            )
            // 缺少密钥时留空：打包任务会在产物校验阶段失败，而 debug 变体与
            // 编译检查仍可照常运行。直接抛异常会让配置阶段整体失败，连
            // compileDebugKotlin 都跑不了。
            signingConfig = signingConfigs.findByName("chatdshRelease")
            if (signingConfig == null) {
                logger.warn("release 变体没有签名密钥：设置 CHATDSH_ANDROID_KEYSTORE 后才能构建 release")
            }
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    buildFeatures {
        compose = true
        buildConfig = false
    }

    sourceSets.getByName("main").assets.srcDir(rootProject.file("AppRelease"))

    packaging {
        resources {
            excludes += "/META-INF/{AL2.0,LGPL2.1}"
        }
    }
}

kotlin {
    jvmToolchain(17)
}

dependencies {
    implementation(project(":shared"))

    val composeBom = platform(libs.androidx.compose.bom)
    implementation(composeBom)

    implementation(libs.androidx.core.ktx)
    implementation(libs.androidx.activity.compose)
    implementation(libs.androidx.datastore.preferences)
    implementation(libs.androidx.exifinterface)
    implementation(libs.androidx.lifecycle.process)
    implementation(libs.androidx.lifecycle.runtime.compose)
    implementation(libs.androidx.lifecycle.viewmodel.compose)
    implementation(libs.androidx.navigation.compose)
    implementation(libs.androidx.window)
    implementation(libs.androidx.compose.ui)
    implementation(libs.androidx.compose.ui.tooling.preview)
    implementation(libs.androidx.compose.material3)
    implementation(libs.kotlinx.coroutines.core)
    implementation(libs.kotlinx.serialization.json)
    implementation(libs.okhttp)
    implementation(libs.backdrop)
    implementation(libs.markwon.core)
    implementation(libs.markwon.ext.strikethrough)
    implementation(libs.markwon.ext.tables)
    implementation(libs.markwon.ext.tasklist)
    implementation(libs.markwon.html)
    implementation(libs.android.svg)
    implementation(libs.androidx.camera.camera2)
    implementation(libs.androidx.camera.lifecycle)
    implementation(libs.androidx.camera.mlkit.vision)
    implementation(libs.androidx.camera.view)
    implementation(libs.mlkit.barcode.scanning)

    debugImplementation(libs.androidx.compose.ui.tooling)
    debugImplementation(libs.androidx.compose.ui.test.manifest)
    testImplementation(libs.junit)
    testImplementation(libs.kotlinx.coroutines.test)
    androidTestImplementation(libs.androidx.test.ext.junit)
    androidTestImplementation(libs.androidx.test.runner)
    // 避免旧 Espresso 反射已移除的 InputManager.getInstance，兼容新模拟器。
    androidTestImplementation("androidx.test.espresso:espresso-core:3.7.0")
    androidTestImplementation(composeBom)
    androidTestImplementation(libs.androidx.compose.ui.test.junit4)
}
