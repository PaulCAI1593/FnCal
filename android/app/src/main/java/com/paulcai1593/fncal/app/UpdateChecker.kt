package com.paulcai1593.fncal.app

import org.json.JSONObject
import java.io.IOException
import java.net.HttpURLConnection
import java.net.URL
import javax.net.ssl.SSLException

/**
 * 0.2.0（范围文档 §B4）：关于页的「检查更新」。
 *
 * 两个源：国内源（jsDelivr 取清单、gh-proxy 取 APK）与直通（GitHub 原生地址）。
 * 只有用户点「检查更新」才走网络，本类没有任何后台任务或定时器。
 *
 * 更新判定：清单的 versionCode 大于当前 versionCode 才算有更新。
 * 下载与安装交给 [AboutActivity]（系统 DownloadManager + 校验 + ACTION_VIEW）。
 *
 * 0.3.1（§B）：jsDelivr 可能返回 CDN 缓存的旧清单（HTTP 200，但 versionCode 落后），
 * 不能当成「已是最新」。国内源返回的 versionCode ≤ 当前安装版本时，再取一次直通源，
 * 两源取 versionCode 较大者；直通源失败则沿用国内源结果。
 */
object UpdateSources {

    enum class Source(val prefValue: String) {
        CN("cn"),
        DIRECT("direct");

        companion object {
            fun fromPref(value: String?): Source =
                if (value == DIRECT.prefValue) DIRECT else CN
        }
    }

    const val MANIFEST_CN = "https://cdn.jsdelivr.net/gh/PaulCAI1593/FnCal@main/android/update.json"
    const val MANIFEST_DIRECT =
        "https://raw.githubusercontent.com/PaulCAI1593/FnCal/main/android/update.json"

    private const val APK_CN_PREFIX =
        "https://gh-proxy.com/https://github.com/PaulCAI1593/FnCal/releases/download/android-v"
    private const val APK_DIRECT_PREFIX =
        "https://github.com/PaulCAI1593/FnCal/releases/download/android-v"

    fun manifestUrl(source: Source): String =
        if (source == Source.DIRECT) MANIFEST_DIRECT else MANIFEST_CN

    /** 资产名由清单给出（FnCal-Android-<版本>.apk），tag 用清单的 versionName。 */
    fun apkUrl(source: Source, manifest: UpdateChecker.Manifest): String {
        val prefix = if (source == Source.DIRECT) APK_DIRECT_PREFIX else APK_CN_PREFIX
        return prefix + manifest.versionName + "/" + manifest.apk
    }
}

object UpdateChecker {

    /** 单次取清单的超时；范围文档要求 8 秒。 */
    private const val TIMEOUT_MS = 8_000

    data class Manifest(
        val versionCode: Int,
        val versionName: String,
        val releasedAt: String,
        val apk: String,
        val notes: List<String>,
    )

    sealed class Outcome {
        /** 有更新。usedFallback = 国内源失败或清单过期后自动改用了直通。 */
        data class Found(
            val manifest: Manifest,
            val source: UpdateSources.Source,
            val usedFallback: Boolean,
        ) : Outcome()

        data class Latest(
            val remoteVersionName: String,
            val source: UpdateSources.Source,
            val usedFallback: Boolean,
        ) : Outcome()

        data class Failure(val message: String) : Outcome()
    }

    /**
     * 检查更新。先试 [preferred]；国内源失败自动改试直通并标记 usedFallback。
     * 国内源成功但 versionCode ≤ 当前版本（CDN 旧缓存）时，也再取一次直通源，
     * 两源结果取 versionCode 较大者。必须在后台线程调用（内部是阻塞 IO）。
     */
    fun check(preferred: UpdateSources.Source, currentVersionCode: Long): Outcome {
        if (preferred == UpdateSources.Source.DIRECT) {
            return try {
                compare(fetch(UpdateSources.Source.DIRECT), currentVersionCode, UpdateSources.Source.DIRECT, false)
            } catch (e: Exception) {
                Outcome.Failure(describe(e))
            }
        }
        return checkFromCn(currentVersionCode)
    }

    /** 国内源优先；失败或清单过期时兜底直通。 */
    private fun checkFromCn(currentVersionCode: Long): Outcome {
        val cn = try {
            fetch(UpdateSources.Source.CN)
        } catch (e: Exception) {
            // 原有兜底：国内源失败时改走直通；两源都失败就报错。
            val cnError = describe(e)
            return try {
                compare(
                    fetch(UpdateSources.Source.DIRECT),
                    currentVersionCode,
                    UpdateSources.Source.DIRECT,
                    true,
                )
            } catch (direct: Exception) {
                Outcome.Failure(cnError + "；直通也失败：" + describe(direct))
            }
        }
        if (cn.versionCode.toLong() > currentVersionCode) {
            return compare(cn, currentVersionCode, UpdateSources.Source.CN, false)
        }
        // 0.3.1（§B）：国内源 ≤ 当前版本 → 再取直通源；两源取 versionCode 较大者。
        val direct = try {
            fetch(UpdateSources.Source.DIRECT)
        } catch (e: Exception) {
            null
        }
        if (direct == null || cn.versionCode >= direct.versionCode) {
            // 直通也取不到或并不更新：沿用国内源结果，最终来源仍是国内源。
            return compare(cn, currentVersionCode, UpdateSources.Source.CN, false)
        }
        return compare(direct, currentVersionCode, UpdateSources.Source.DIRECT, true)
    }

    private fun compare(
        manifest: Manifest,
        currentVersionCode: Long,
        source: UpdateSources.Source,
        usedFallback: Boolean,
    ): Outcome = if (manifest.versionCode.toLong() > currentVersionCode) {
        Outcome.Found(manifest, source, usedFallback)
    } else {
        Outcome.Latest(manifest.versionName, source, usedFallback)
    }

    private fun fetch(source: UpdateSources.Source): Manifest {
        val connection = (URL(UpdateSources.manifestUrl(source)).openConnection() as HttpURLConnection).apply {
            requestMethod = "GET"
            connectTimeout = TIMEOUT_MS
            readTimeout = TIMEOUT_MS
            setRequestProperty("Accept", "application/json")
            // 不走缓存：清单每次发版都会变。
            setRequestProperty("Cache-Control", "no-cache")
        }
        try {
            val code = connection.responseCode
            if (code != HttpURLConnection.HTTP_OK) {
                throw IOException("HTTP " + code)
            }
            val body = connection.inputStream.bufferedReader(Charsets.UTF_8).use { it.readText() }
            return parse(body)
        } finally {
            connection.disconnect()
        }
    }

    private fun parse(body: String): Manifest {
        val json = JSONObject(body)
        val versionCode = json.optInt("versionCode", -1)
        val versionName = json.optString("versionName").trim()
        val apk = json.optString("apk").trim()
        if (versionCode <= 0 || versionName.isEmpty() || apk.isEmpty()) {
            throw IOException("清单字段不完整")
        }
        if (apk.contains("/") || apk.contains("\\")) {
            // 只接受资产名，防止清单把下载指向别的路径。
            throw IOException("清单 apk 字段不合法")
        }
        val notes = mutableListOf<String>()
        val array = json.optJSONArray("notes")
        if (array != null) {
            for (index in 0 until array.length()) {
                val note = array.optString(index).trim()
                if (note.isNotEmpty()) notes.add(note)
            }
        }
        return Manifest(
            versionCode = versionCode,
            versionName = versionName,
            releasedAt = json.optString("releasedAt").trim(),
            apk = apk,
            notes = notes,
        )
    }

    private fun describe(e: Exception): String = when (e) {
        is SSLException -> "证书错误，无法连接更新服务器"
        is java.net.SocketTimeoutException -> "连接更新服务器超时"
        is java.net.UnknownHostException -> "无法解析更新服务器地址"
        is IOException -> e.message ?: "读取更新清单失败"
        else -> "检查更新失败（" + e.javaClass.simpleName + "）"
    }
}
