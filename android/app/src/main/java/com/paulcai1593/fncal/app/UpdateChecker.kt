package com.paulcai1593.fncal.app

import org.json.JSONObject
import java.io.IOException
import java.net.HttpURLConnection
import java.net.URL
import javax.net.ssl.SSLException

/**
 * 0.2.0（范围文档 §B4）：关于页的「检查更新」。
 *
 * 0.3.6（§A 修订，用户口径「gitee、github 就两个源」）：只有两个清单源，顺序固定 ——
 * Gitee 镜像先、GitHub 直通后。用户不再选择源，关于页没有单选控件。
 * 只有用户点「检查更新」才走网络，本类没有任何后台任务或定时器。
 *
 * 更新判定：清单的 versionCode 大于当前 versionCode 才算有更新。
 * 下载与安装交给 [AboutActivity]（系统 DownloadManager + 校验 + ACTION_VIEW）。
 *
 * 0.3.1（§B）的教训：某个源返回 HTTP 200、但 versionCode 落后（CDN 旧缓存）时，
 * 不能当成「已是最新」，必须继续试下一个源。
 *
 * 0.3.6（§B）：清单可带可选字段 apkCn（Gitee 发行版附件直链）。缺字段不报错，
 * 行为与 0.3.5 相同；有字段时先下 Gitee 附件，失败一次再下 GitHub Release。
 */
object UpdateSources {

    enum class Source { GITEE, GITHUB }

    companion object {
        /** 0.3.6（§A 修订）：两源固定顺序，Gitee 永远第一。 */
        val checkOrder: List<Source> = listOf(GITEE, GITHUB)
    }

    const val MANIFEST_GITEE = "https://gitee.com/Paul1593/FnCal/raw/main/android/update.json"
    const val MANIFEST_GITHUB =
        "https://raw.githubusercontent.com/PaulCAI1593/FnCal/main/android/update.json"

    // 第三方加速代理已删除；GitHub 只直连，国内下载由清单里的 apkCn 承担。
    private const val APK_GITHUB_PREFIX =
        "https://github.com/PaulCAI1593/FnCal/releases/download/android-v"

    /** 一次下载尝试：地址 + 落盘文件名（两个地址都统一用清单里的 apk 名）。 */
    data class DownloadTarget(val url: String, val fileName: String)

    fun manifestUrl(source: Source): String = when (source) {
        Source.GITEE -> MANIFEST_GITEE
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
}

object UpdateChecker {

    /** 单次取清单的超时；范围文档要求 8 秒。 */
    private const val TIMEOUT_MS = 8_000

    /** 诊断行里单个源的展示名；不随界面语言变，方便用户截图。 */
    fun sourceTag(source: UpdateSources.Source): String = when (source) {
        UpdateSources.Source.GITEE -> "Gitee"
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

    /** 单个源的检查结果（诊断行用）：status 是 `200` / `HTTP 404` / `超时` / `未试`。 */
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
     * 0.3.6（§A 修订）：按 Gitee → GitHub 依次试。
     *
     * - 任一源返回 versionCode > 当前版本：立即采用，结束。
     * - 某源返回 versionCode ≤ 当前版本：继续试下一个（0.3.1 的 bug 不允许重演）。
     * - 两源都不比当前新：取两者里 versionCode 最大的有效清单，报「已是最新（X）」。
     * - 都失败：报第一个失败原因。
     *
     * 每个源的结果（状态码 / 失败原因 / 未试）都写进 [Outcome.diagnostics]。
     * 必须在后台线程调用（内部是阻塞 IO）。
     */
    fun check(currentVersionCode: Long): Outcome {
        var best: Manifest? = null
        var bestSource: UpdateSources.Source? = null
        var firstError: String? = null
        val attempts = mutableListOf<SourceAttempt>()
        val order = UpdateSources.checkOrder
        for ((index, source) in order.withIndex()) {
            val manifest = try {
                fetch(source)
            } catch (e: Exception) {
                if (firstError == null) firstError = describe(e)
                attempts.add(SourceAttempt(source, shortStatus(e)))
                null
            } ?: continue
            attempts.add(SourceAttempt(source, "200"))
            val current = best
            if (current == null || manifest.versionCode > current.versionCode) {
                best = manifest
                bestSource = source
            }
            if (manifest.versionCode.toLong() > currentVersionCode) {
                return Outcome.Found(
                    manifest,
                    source,
                    attempts + untried(order, index + 1),
                )
            }
            // 这个源不比当前新：不判最新，继续下一个源（§11 关键）。
        }
        val winner = best
        val winnerSource = bestSource
        if (winner != null && winnerSource != null) {
            return Outcome.Latest(winner.versionName, winnerSource, attempts)
        }
        return Outcome.Failure(
            "检查更新失败：" + (firstError ?: "所有更新源都不可用"),
            attempts,
        )
    }

    private fun untried(
        order: List<UpdateSources.Source>,
        from: Int,
    ): List<SourceAttempt> =
        if (from >= order.size) emptyList()
        else order.drop(from).map { SourceAttempt(it, "未试") }

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

    /** 诊断行用的短状态：能放下两个源，不用整句。 */
    private fun shortStatus(e: Exception): String = when (e) {
        is SSLException -> "证书"
        is java.net.SocketTimeoutException -> "超时"
        is java.net.UnknownHostException -> "DNS"
        is IOException -> (e.message ?: "失败").take(18)
        else -> e.javaClass.simpleName.take(18)
    }

    private fun describe(e: Exception): String = when (e) {
        is SSLException -> "证书错误，无法连接更新服务器"
        is java.net.SocketTimeoutException -> "连接更新服务器超时"
        is java.net.UnknownHostException -> "无法解析更新服务器地址"
        is IOException -> e.message ?: "读取更新清单失败"
        else -> "检查更新失败（" + e.javaClass.simpleName + "）"
    }
}
