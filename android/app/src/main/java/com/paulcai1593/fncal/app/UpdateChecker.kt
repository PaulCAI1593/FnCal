package com.paulcai1593.fncal.app

import org.json.JSONObject
import java.io.IOException
import java.net.HttpURLConnection
import java.net.URL
import javax.net.ssl.SSLException

/**
 * 0.2.0（范围文档 §B4）：关于页的「检查更新」。
 *
 * 0.4.3（§A 三源）：清单按 Gitee API → jsDelivr → GitHub raw 依次试，任一成功即结束。
 * 起因：0.3.8 起「检查更新」在部分网络报 Gitee 无法连接——旧的 raw 清单地址现在返回 302，
 * 跳到一个 CDN 域名，该域名在部分网络 TLS 握手即被断
 * （SSL: UNEXPECTED_EOF_WHILE_READING）。改走 Gitee API 后不经过该 CDN 域名。
 *
 * Gitee API 返回的是仓库文件元数据，清单正文在 `content` 字段、`encoding=base64`，
 * 必须先 base64 解码再按 JSON 解析。
 *
 * 只有用户点「检查更新」才走网络，本类没有任何后台任务或定时器。
 *
 * 更新判定：清单的 versionCode 大于当前 versionCode 才算有更新。
 *
 * 0.3.1（§B）的教训：某个源返回 HTTP 200、但 versionCode 落后（CDN 旧缓存）时，
 * 不能当成「已是最新」，必须继续试下一个源，取最大 versionCode。
 */
object UpdateSources {

    enum class Source { GITEE_API, JSDELIVR, GITHUB }

    /** 0.4.3（§A）：三源固定顺序，Gitee API 永远第一。 */
    val checkOrder: List<Source> = listOf(Source.GITEE_API, Source.JSDELIVR, Source.GITHUB)

    /** 0.4.3（§A）：Gitee API 读文件元数据；正文在 content（base64）。 */
    const val MANIFEST_GITEE_API =
        "https://gitee.com/api/v5/repos/Paul1593/FnCal/contents/android/update.json?ref=main"

    /** 0.4.3（§A）：jsDelivr CDN 直出清单 JSON；可能带 12 小时旧缓存。 */
    const val MANIFEST_JSDELIVR =
        "https://cdn.jsdelivr.net/gh/PaulCAI1593/FnCal@main/android/update.json"

    /** 0.4.3（§A）：GitHub raw 直出清单 JSON。 */
    const val MANIFEST_GITHUB =
        "https://raw.githubusercontent.com/PaulCAI1593/FnCal/main/android/update.json"

    // 第三方加速代理已删除；GitHub 只直连，国内下载由清单里的 apkCn 承担。
    private const val APK_GITHUB_PREFIX =
        "https://github.com/PaulCAI1593/FnCal/releases/download/android-v"

    /** 一次下载尝试：地址 + 落盘文件名（两个地址都统一用清单里的 apk 名）。 */
    data class DownloadTarget(val url: String, val fileName: String)

    fun manifestUrl(source: Source): String = when (source) {
        Source.GITEE_API -> MANIFEST_GITEE_API
        Source.JSDELIVR -> MANIFEST_JSDELIVR
        Source.GITHUB -> MANIFEST_GITHUB
    }

    /** 资产名由清单给出（FnCal-Android-<版本>.apk），tag 用清单的 versionName。 */
    fun apkUrl(manifest: UpdateChecker.Manifest): String =
        APK_GITHUB_PREFIX + manifest.versionName + "/" + manifest.apk

    /** 0.3.6（§B）：清单里的 Gitee 附件直链；没有或为空时返回 null。 */
    fun giteeApkUrl(manifest: UpdateChecker.Manifest): String? =
        manifest.apkCn?.takeIf { it.isNotBlank() }

    /**
     * 0.3.6（§B）：两条下载地址，顺序固定。
     *
     * - 清单有 `apkCn`：先 Gitee 附件，失败一次再 GitHub Release。
     * - 清单没有 `apkCn`：只走 GitHub Release，行为同 0.3.5。
     *
     * 两个地址落盘都用清单里的 `apk` 名，安装前仍按 versionCode 校验包内容。
     */
    fun downloadTargets(manifest: UpdateChecker.Manifest): List<DownloadTarget> {
        val github = DownloadTarget(apkUrl(manifest), manifest.apk)
        val gitee = giteeApkUrl(manifest)?.let { DownloadTarget(it, manifest.apk) }
        return listOfNotNull(gitee, github)
    }

    /**
     * 0.4.3（§十一 先探后下）：选定清单后先探 `apkCn`，再决定下载顺序。
     *
     * - `apkCn` 可达（2xx）：`[apkCn, GitHub 直链]`，与 0.3.6 的两次尝试一致。
     * - `apkCn` 不通（非 2xx / 超时 / 异常）：只给 GitHub 直链，不把死链交给
     *   DownloadManager（撤版后 jsDelivr 仍可能发旧清单，旧 `apkCn` 会 404）。
     * - 两个地址都不通：返回空表，由界面提示「暂时取不到安装包」，不下载。
     *
     * [probe] 默认真实 HEAD 请求；单测注入桩，避免连网。必须在后台线程调用。
     */
    fun planDownload(
        manifest: UpdateChecker.Manifest,
        probe: (String) -> Boolean = { UpdateChecker.probeUrl(it) },
    ): List<DownloadTarget> {
        val github = DownloadTarget(apkUrl(manifest), manifest.apk)
        val cnUrl = giteeApkUrl(manifest)
        if (cnUrl != null && safeProbe(probe, cnUrl)) {
            return listOf(DownloadTarget(cnUrl, manifest.apk), github)
        }
        if (safeProbe(probe, github.url)) {
            return listOf(github)
        }
        return emptyList()
    }

    /** 探测桩抛异常时按「不通」处理，绝不让探测把下载流程打断。 */
    private fun safeProbe(probe: (String) -> Boolean, url: String): Boolean =
        try {
            probe(url)
        } catch (e: Exception) {
            false
        }
}

object UpdateChecker {

    /** 单次取清单的超时；范围文档要求 8 秒（每个源单独计）。 */
    private const val TIMEOUT_MS = 8_000

    /** 0.4.3（§十一）：下载前探测 `apkCn` 的超时，3 秒（主席口径）。 */
    private const val PROBE_TIMEOUT_MS = 3_000

    /**
     * 0.4.3（§十一 先探后下）：对安装包地址发一次 HEAD，只认 2xx。
     *
     * 超时、DNS 失败、TLS 断连、5xx、跳转后仍非 2xx 一律 false——
     * 探测结果只用来决定「用哪个地址」，失败不抛给界面。
     * 必须在后台线程调用（阻塞 IO）。
     */
    fun probeUrl(url: String, timeoutMs: Int = PROBE_TIMEOUT_MS): Boolean {
        val connection = try {
            (URL(url).openConnection() as HttpURLConnection).apply {
                requestMethod = "HEAD"
                connectTimeout = timeoutMs
                readTimeout = timeoutMs
                instanceFollowRedirects = true
                setRequestProperty("Accept", "application/octet-stream")
                setRequestProperty("Cache-Control", "no-cache")
            }
        } catch (e: Exception) {
            return false
        }
        return try {
            val code = connection.responseCode
            code in 200..299
        } catch (e: Exception) {
            false
        } finally {
            connection.disconnect()
        }
    }

    /** 诊断行里单个源的展示名；不随界面语言变，方便用户截图。 */
    fun sourceTag(source: UpdateSources.Source): String = when (source) {
        UpdateSources.Source.GITEE_API -> "Gitee"
        UpdateSources.Source.JSDELIVR -> "jsDelivr"
        UpdateSources.Source.GITHUB -> "GitHub"
    }

    data class Manifest(
        val versionCode: Int,
        val versionName: String,
        val releasedAt: String,
        val apk: String,
        val notes: List<String>,
        /** 0.3.6（§B）：可选，Gitee 发行版附件直链。 */
        val apkCn: String? = null,
    )

    /** 单个源的检查结果（诊断行用）：status 是 `200` / `200 旧` / `HTTP 404` / `超时` / `未试`。 */
    data class SourceAttempt(
        val source: UpdateSources.Source,
        val status: String,
    )

    sealed class Outcome {
        abstract val diagnostics: List<SourceAttempt>

        /** 有更新。 */
        data class Found(
            val manifest: Manifest,
            val source: UpdateSources.Source,
            override val diagnostics: List<SourceAttempt> = emptyList(),
        ) : Outcome()

        data class Latest(
            val remoteVersionName: String,
            val source: UpdateSources.Source,
            override val diagnostics: List<SourceAttempt> = emptyList(),
        ) : Outcome()

        data class Failure(
            val message: String,
            override val diagnostics: List<SourceAttempt> = emptyList(),
        ) : Outcome()
    }

    /**
     * 0.4.3（§A）：按 Gitee API → jsDelivr → GitHub raw 依次试。
     *
     * - 任一源返回 versionCode > 当前版本：立即采用，结束。
     * - 某源返回 versionCode ≤ 当前版本：继续试下一个（0.3.1 的 bug 不允许重演）。
     * - 三源都不比当前新：取三者里 versionCode 最大的有效清单，报「已是最新（X）」。
     * - 三源都失败：报一次失败，文案不点名某个源（各源状态仍在 [Outcome.diagnostics]）。
     *
     * [fetcher] 默认真实网络请求；单测注入桩，避免连网。
     * 必须在后台线程调用（内部是阻塞 IO）。
     */
    fun check(
        currentVersionCode: Long,
        fetcher: (UpdateSources.Source) -> String = ::fetchBody,
    ): Outcome {
        var best: Manifest? = null
        var bestSource: UpdateSources.Source? = null
        val attempts = mutableListOf<SourceAttempt>()
        val order = UpdateSources.checkOrder
        for ((index, source) in order.withIndex()) {
            val manifest = try {
                parseManifestBody(source, fetcher(source))
            } catch (e: Exception) {
                attempts.add(SourceAttempt(source, shortStatus(e)))
                continue
            }
            val lagging = manifest.versionCode.toLong() <= currentVersionCode
            attempts.add(SourceAttempt(source, if (lagging) "200 旧" else "200"))
            val current = best
            if (current == null || manifest.versionCode > current.versionCode) {
                best = manifest
                bestSource = source
            }
            if (!lagging) {
                return Outcome.Found(
                    manifest,
                    source,
                    attempts + untried(order, index + 1),
                )
            }
            // 这个源不比当前新：不判最新，继续下一个源（§11 关键；jsDelivr 有 12 小时缓存）。
        }
        val winner = best
        val winnerSource = bestSource
        if (winner != null && winnerSource != null) {
            return Outcome.Latest(winner.versionName, winnerSource, attempts)
        }
        return Outcome.Failure("所有更新源都不可用", attempts)
    }

    private fun untried(
        order: List<UpdateSources.Source>,
        from: Int,
    ): List<SourceAttempt> =
        if (from >= order.size) emptyList()
        else order.drop(from).map { SourceAttempt(it, "未试") }

    /**
     * 0.4.3（§A）：取一个源的清单正文。
     *
     * Gitee API 返回的是文件元数据，正文在 `content`（base64）；把解码与 JSON
     * 解析都收在这里，[check] 只关心结果。
     */
    internal fun parseManifestBody(source: UpdateSources.Source, body: String): Manifest {
        if (source != UpdateSources.Source.GITEE_API) {
            return parseManifest(JSONObject(body))
        }
        val wrapper = try {
            JSONObject(body)
        } catch (e: Exception) {
            throw IOException("Gitee 清单格式错误", e)
        }
        val content = wrapper.optString("content")
        if (content.isBlank()) {
            throw IOException("Gitee 清单内容为空")
        }
        val decoded = decodeBase64(content)
        if (decoded.isBlank()) {
            throw IOException("Gitee 清单内容为空")
        }
        val json = try {
            JSONObject(decoded)
        } catch (e: Exception) {
            throw IOException("Gitee 清单解析失败", e)
        }
        return parseManifest(json)
    }

    /**
     * 标准 base64 解码（忽略换行与空白，遇到 `=` 结束）。
     *
     * 不用 `android.util.Base64`：minSdk 24 时它可以，但 JVM 单测里不可用；
     * 也不用 `java.util.Base64`：它要 API 26。自己解十几行，Android 与 JVM 都跑得动。
     */
    internal fun decodeBase64(text: String): String {
        val alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/"
        val out = ByteArray(text.length * 3 / 4 + 3)
        var buffer = 0
        var bits = 0
        var count = 0
        for (ch in text) {
            if (ch == '\n' || ch == '\r' || ch == ' ' || ch == '\t') continue
            if (ch == '=') break
            val value = alphabet.indexOf(ch)
            if (value < 0) {
                throw IOException("Gitee 清单编码不合法")
            }
            buffer = (buffer shl 6) or value
            bits += 6
            if (bits >= 8) {
                bits -= 8
                out[count++] = ((buffer shr bits) and 0xFF).toByte()
                buffer = buffer and ((1 shl bits) - 1)
            }
        }
        return String(out, 0, count, Charsets.UTF_8)
    }

    private fun fetchBody(source: UpdateSources.Source): String {
        val connection =
            (URL(UpdateSources.manifestUrl(source)).openConnection() as HttpURLConnection).apply {
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
            return connection.inputStream.bufferedReader(Charsets.UTF_8).use { it.readText() }
        } finally {
            connection.disconnect()
        }
    }

    private fun parseManifest(json: JSONObject): Manifest {
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
        // 0.3.6（§B）：apkCn 可缺省。字段坏了也不让整条清单失效，按缺省处理。
        val apkCnRaw = json.optString("apkCn").trim()
        val apkCn = apkCnRaw.takeIf {
            it.startsWith("https://") && !it.contains(" ") && !it.contains("\n")
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
            apkCn = apkCn,
        )
    }

    /** 诊断行用的短状态：三个源也要一行放得下，不用整句。 */
    private fun shortStatus(e: Exception): String = when (e) {
        is SSLException -> "证书"
        is java.net.SocketTimeoutException -> "超时"
        is java.net.UnknownHostException -> "DNS"
        is IOException -> (e.message ?: "失败").take(18)
        else -> e.javaClass.simpleName.take(18)
    }
}
