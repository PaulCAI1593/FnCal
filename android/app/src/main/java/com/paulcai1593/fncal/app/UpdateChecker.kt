package com.paulcai1593.fncal.app

import org.json.JSONObject
import java.io.IOException
import java.net.HttpURLConnection
import java.net.URL
import javax.net.ssl.SSLException

/**
 * 0.2.0（范围文档 §B4）：关于页的「检查更新」。
 *
 * 0.3.4（§11）：三个清单源，顺序即优先级 —— Pages、国内源（jsDelivr）、直通。
 * 只有用户点「检查更新」才走网络，本类没有任何后台任务或定时器。
 *
 * 更新判定：清单的 versionCode 大于当前 versionCode 才算有更新。
 * 下载与安装交给 [AboutActivity]（系统 DownloadManager + 校验 + ACTION_VIEW）。
 *
 * 0.3.1（§B）的教训：某个源返回 HTTP 200、但 versionCode 落后（CDN 旧缓存）时，
 * 不能当成「已是最新」，必须继续试下一个源。
 */
object UpdateSources {

    enum class Source(val prefValue: String) {
        PAGES("pages"),
        CN("cn"),
        DIRECT("direct");

        companion object {
            /** 0.3.4（§11）：固定的检查顺序，Pages 永远第一。 */
            val checkOrder: List<Source> = listOf(PAGES, CN, DIRECT)

            fun fromPref(value: String?): Source = when (value) {
                DIRECT.prefValue -> DIRECT
                CN.prefValue -> CN
                else -> PAGES
            }
        }
    }

    const val MANIFEST_PAGES = "https://paulcai1593.github.io/FnCal/update.json"
    const val MANIFEST_CN = "https://cdn.jsdelivr.net/gh/PaulCAI1593/FnCal@main/android/update.json"
    const val MANIFEST_DIRECT =
        "https://raw.githubusercontent.com/PaulCAI1593/FnCal/main/android/update.json"

    private const val APK_CN_PREFIX =
        "https://gh-proxy.com/https://github.com/PaulCAI1593/FnCal/releases/download/android-v"
    private const val APK_DIRECT_PREFIX =
        "https://github.com/PaulCAI1593/FnCal/releases/download/android-v"

    /** Pages 只放清单，APK 仍从 GitHub Release 取（与直通同前缀）。 */
    fun manifestUrl(source: Source): String = when (source) {
        Source.PAGES -> MANIFEST_PAGES
        Source.CN -> MANIFEST_CN
        Source.DIRECT -> MANIFEST_DIRECT
    }

    /** 资产名由清单给出（FnCal-Android-<版本>.apk），tag 用清单的 versionName。 */
    fun apkUrl(source: Source, manifest: UpdateChecker.Manifest): String {
        val prefix = if (source == Source.CN) APK_CN_PREFIX else APK_DIRECT_PREFIX
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
        /** 有更新。usedFallback = 结果不是来自第一优先的 Pages 源。 */
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
     * 0.3.4（§11）：按 Pages → 国内源 → 直通 依次试。
     *
     * - 任一源返回 versionCode > 当前版本：立即采用，结束。
     * - 某源返回 versionCode ≤ 当前版本：继续试下一个（0.3.1 的 bug 不允许重演）。
     * - 三源都不比当前新：取三者里 versionCode 最大的有效清单，报「已是最新（X）」。
     * - 全失败：报第一个失败原因。
     *
     * [preferred] 是用户在关于页选的源（国内源 / 直通）；它只影响 Pages 之后先试谁，
     * Pages 永远是第一个。必须在后台线程调用（内部是阻塞 IO）。
     */
    fun check(preferred: UpdateSources.Source, currentVersionCode: Long): Outcome {
        var best: Manifest? = null
        var bestSource: UpdateSources.Source? = null
        var firstError: String? = null
        for (source in checkOrder(preferred)) {
            val manifest = try {
                fetch(source)
            } catch (e: Exception) {
                if (firstError == null) firstError = describe(e)
                null
            } ?: continue
            val current = best
            if (current == null || manifest.versionCode > current.versionCode) {
                best = manifest
                bestSource = source
            }
            if (manifest.versionCode.toLong() > currentVersionCode) {
                return Outcome.Found(
                    manifest,
                    source,
                    source != UpdateSources.Source.PAGES,
                )
            }
            // 这个源不比当前新：不判最新，继续下一个源（§11 关键）。
        }
        val winner = best
        val winnerSource = bestSource
        if (winner != null && winnerSource != null) {
            return Outcome.Latest(
                winner.versionName,
                winnerSource,
                winnerSource != UpdateSources.Source.PAGES,
            )
        }
        return Outcome.Failure("检查更新失败：" + (firstError ?: "所有更新源都不可用"))
    }

    /** Pages 固定第一；[preferred] 决定 Pages 之后先试国内源还是直通。 */
    private fun checkOrder(preferred: UpdateSources.Source): List<UpdateSources.Source> {
        val order = mutableListOf(UpdateSources.Source.PAGES)
        for (source in listOf(preferred, UpdateSources.Source.CN, UpdateSources.Source.DIRECT)) {
            if (source !in order) order.add(source)
        }
        return order
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
