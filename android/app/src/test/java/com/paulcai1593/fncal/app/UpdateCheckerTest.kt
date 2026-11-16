package com.paulcai1593.fncal.app

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.IOException
import java.net.SocketTimeoutException

/**
 * 0.4.3（§A）：三源更新检查的六类单测。
 *
 * 1. 三源各单独成功；
 * 2. 逐级回落（前一源失败换下一源）；
 * 3. 版本落后继续试（0.3.1 的 bug 不得重演）；
 * 4. 三源全败只报一次、文案不点名某源；
 * 5. Gitee base64 三种异常（空内容 / 编码不合法 / 解码后不是 JSON）；
 * 6. 非 200 与超时。
 *
 * 全部用注入的 fetcher 桩，不连网。
 */
class UpdateCheckerTest {

    private fun body(
        code: Int,
        name: String,
        apk: String = "FnCal-Android-$name.apk",
        apkCn: String? = null,
        notes: List<String> = listOf("测试"),
    ): String {
        val json = JSONObject()
        json.put("versionCode", code)
        json.put("versionName", name)
        json.put("releasedAt", "2026-11-16")
        json.put("apk", apk)
        json.put("notes", notes)
        if (apkCn != null) json.put("apkCn", apkCn)
        return json.toString()
    }

    /** Gitee API 的外壳：文件元数据 + base64 正文。 */
    private fun giteeWrapper(json: String, splitLines: Boolean = false): String {
        var encoded = encodeBase64(json)
        if (splitLines) encoded = encoded.chunked(60).joinToString("\n")
        val wrapper = JSONObject()
        wrapper.put("content", encoded)
        wrapper.put("encoding", "base64")
        return wrapper.toString()
    }

    private fun encodeBase64(text: String): String {
        val alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/"
        val bytes = text.toByteArray(Charsets.UTF_8)
        val out = StringBuilder()
        var index = 0
        while (index < bytes.size) {
            val b0 = bytes[index].toInt() and 0xFF
            val b1 = if (index + 1 < bytes.size) bytes[index + 1].toInt() and 0xFF else 0
            val b2 = if (index + 2 < bytes.size) bytes[index + 2].toInt() and 0xFF else 0
            val chunk = (b0 shl 16) or (b1 shl 8) or b2
            out.append(alphabet[(chunk shr 18) and 0x3F])
            out.append(alphabet[(chunk shr 12) and 0x3F])
            out.append(if (index + 1 < bytes.size) alphabet[(chunk shr 6) and 0x3F] else '=')
            out.append(if (index + 2 < bytes.size) alphabet[chunk and 0x3F] else '=')
            index += 3
        }
        return out.toString()
    }

    // ---------- 1. 三源各单独成功 ----------

    @Test
    fun giteeApiSuccessDecodesBase64Content() {
        val outcome = UpdateChecker.check(400) { asked ->
            if (asked == UpdateSources.Source.GITEE_API) {
                giteeWrapper(body(403, "0.4.3"))
            } else {
                throw IOException("不应轮到 " + asked)
            }
        }
        assertTrue(outcome is UpdateChecker.Outcome.Found)
        val found = outcome as UpdateChecker.Outcome.Found
        assertEquals(UpdateSources.Source.GITEE_API, found.source)
        assertEquals(403, found.manifest.versionCode)
        assertEquals("0.4.3", found.manifest.versionName)
        assertEquals("FnCal-Android-0.4.3.apk", found.manifest.apk)
        // 第一个源就成功，后面的源不该被请求。
        assertEquals(
            listOf(
                UpdateChecker.SourceAttempt(UpdateSources.Source.GITEE_API, "200"),
                UpdateChecker.SourceAttempt(UpdateSources.Source.JSDELIVR, "未试"),
                UpdateChecker.SourceAttempt(UpdateSources.Source.GITHUB, "未试"),
            ),
            found.diagnostics,
        )
    }

    @Test
    fun giteeApiAcceptsBase64WithLineBreaks() {
        val text = giteeWrapper(body(403, "0.4.3"), splitLines = true)
        val manifest = UpdateChecker.parseManifestBody(UpdateSources.Source.GITEE_API, text)
        assertEquals(403, manifest.versionCode)
    }

    @Test
    fun jsdelivrSuccessParsesPlainJson() {
        val outcome = UpdateChecker.check(400) { asked ->
            when (asked) {
                UpdateSources.Source.GITEE_API -> throw IOException("HTTP 404")
                UpdateSources.Source.JSDELIVR -> body(403, "0.4.3")
                else -> throw IOException("不应轮到 GitHub")
            }
        }
        val found = outcome as UpdateChecker.Outcome.Found
        assertEquals(UpdateSources.Source.JSDELIVR, found.source)
        assertEquals("HTTP 404", found.diagnostics[0].status)
    }

    @Test
    fun githubSuccessParsesPlainJsonAndKeepsApkCn() {
        val outcome = UpdateChecker.check(400) { asked ->
            when (asked) {
                UpdateSources.Source.GITHUB -> body(
                    403,
                    "0.4.3",
                    apkCn = "https://gitee.com/Paul1593/FnCal/releases/download/android-v0.4.3/FnCal-Android-0.4.3.apk",
                )
                else -> throw SocketTimeoutException("timeout")
            }
        }
        val found = outcome as UpdateChecker.Outcome.Found
        assertEquals(UpdateSources.Source.GITHUB, found.source)
        val targets = UpdateSources.downloadTargets(found.manifest)
        // 下载顺序不变：apkCn 优先，失败一次转 GitHub Release。
        assertEquals(2, targets.size)
        assertTrue(targets[0].url.contains("gitee.com"))
        assertTrue(targets[1].url.contains("github.com"))
        assertEquals("FnCal-Android-0.4.3.apk", targets[0].fileName)
    }

    // ---------- 2. 逐级回落 ----------

    @Test
    fun fallsBackSourceBySource() {
        // Gitee API 与 jsDelivr 都失败，只有 GitHub 成功。
        val outcome = UpdateChecker.check(400) { asked ->
            when (asked) {
                UpdateSources.Source.GITEE_API -> throw IOException("HTTP 403")
                UpdateSources.Source.JSDELIVR -> throw IOException("HTTP 429")
                UpdateSources.Source.GITHUB -> body(403, "0.4.3")
            }
        }
        val found = outcome as UpdateChecker.Outcome.Found
        assertEquals(UpdateSources.Source.GITHUB, found.source)
        assertEquals(listOf("HTTP 403", "HTTP 429", "200"), found.diagnostics.map { it.status })
    }

    // ---------- 3. 版本落后继续试 ----------

    @Test
    fun keepsTryingWhenSourceVersionIsStale() {
        // 第一个源 200 但 versionCode = 当前（CDN 旧缓存），必须继续下一个源。
        val asked = mutableListOf<UpdateSources.Source>()
        val outcome = UpdateChecker.check(402) { source ->
            asked.add(source)
            when (source) {
                UpdateSources.Source.GITEE_API -> giteeWrapper(body(402, "0.4.2"))
                UpdateSources.Source.JSDELIVR -> body(403, "0.4.3")
                else -> throw IOException("不应轮到 GitHub")
            }
        }
        val found = outcome as UpdateChecker.Outcome.Found
        assertEquals(UpdateSources.Source.JSDELIVR, found.source)
        assertEquals(
            listOf(UpdateSources.Source.GITEE_API, UpdateSources.Source.JSDELIVR),
            asked,
        )
        assertEquals("200 旧", found.diagnostics[0].status)
    }

    @Test
    fun latestUsesMaxVersionWhenEverySourceIsStale() {
        // 三源都比当前旧/相同：不算失败，取最大 versionCode 报「已是最新」。
        val outcome = UpdateChecker.check(410) { source ->
            when (source) {
                UpdateSources.Source.GITEE_API -> giteeWrapper(body(402, "0.4.2"))
                UpdateSources.Source.JSDELIVR -> body(408, "0.4.8")
                UpdateSources.Source.GITHUB -> body(403, "0.4.3")
            }
        }
        val latest = outcome as UpdateChecker.Outcome.Latest
        assertEquals("0.4.8", latest.remoteVersionName)
        assertEquals(UpdateSources.Source.JSDELIVR, latest.source)
        assertEquals(listOf("200 旧", "200 旧", "200 旧"), latest.diagnostics.map { it.status })
    }

    // ---------- 4. 三源全败 ----------

    @Test
    fun allSourcesFailReportsOneSourceNeutralFailure() {
        val outcome = UpdateChecker.check(402) { source ->
            when (source) {
                UpdateSources.Source.GITEE_API -> throw IOException("HTTP 500")
                UpdateSources.Source.JSDELIVR -> throw SocketTimeoutException("timeout")
                UpdateSources.Source.GITHUB -> throw IOException("HTTP 404")
            }
        }
        val failure = outcome as UpdateChecker.Outcome.Failure
        assertEquals("所有更新源都不可用", failure.message)
        // 文案不点名某一源（界面只显示这一句 + 诊断行）。
        assertTrue(!failure.message.contains("Gitee"))
        assertTrue(!failure.message.contains("jsDelivr"))
        assertTrue(!failure.message.contains("GitHub"))
        assertEquals(3, failure.diagnostics.size)
        assertEquals("超时", failure.diagnostics[1].status)
    }

    // ---------- 5. Gitee base64 三种异常 ----------

    @Test
    fun giteeEmptyContentFails() {
        val wrapper = JSONObject().put("content", "").toString()
        try {
            UpdateChecker.parseManifestBody(UpdateSources.Source.GITEE_API, wrapper)
            throw AssertionError("空 content 应当抛 IOException")
        } catch (e: IOException) {
            assertEquals("Gitee 清单内容为空", e.message)
        }
    }

    @Test
    fun giteeInvalidBase64Fails() {
        // `-` 与 `?` 都不是标准 base64 字符。
        val wrapper = JSONObject().put("content", "abc\$def?ghi").toString()
        try {
            UpdateChecker.parseManifestBody(UpdateSources.Source.GITEE_API, wrapper)
            throw AssertionError("非法 base64 应当抛 IOException")
        } catch (e: IOException) {
            assertEquals("Gitee 清单编码不合法", e.message)
        }
    }

    @Test
    fun giteeDecodedNonJsonFails() {
        // 正文合法 base64，但解码后不是 JSON。
        val wrapper = giteeWrapper("not a json body")
        try {
            UpdateChecker.parseManifestBody(UpdateSources.Source.GITEE_API, wrapper)
            throw AssertionError("解码后非 JSON 应当抛 IOException")
        } catch (e: IOException) {
            assertEquals("Gitee 清单解析失败", e.message)
        }
    }

    @Test
    fun giteeWrapperNotJsonFails() {
        try {
            UpdateChecker.parseManifestBody(UpdateSources.Source.GITEE_API, "<html>502</html>")
            throw AssertionError("外壳不是 JSON 应当抛 IOException")
        } catch (e: IOException) {
            assertEquals("Gitee 清单格式错误", e.message)
        }
    }

    // ---------- 6. 非 200 与超时 ----------

    @Test
    fun non200StatusIsShortAndMovesToNextSource() {
        val outcome = UpdateChecker.check(400) { source ->
            when (source) {
                UpdateSources.Source.GITEE_API -> throw IOException("HTTP 404")
                UpdateSources.Source.JSDELIVR -> throw IOException("HTTP 429")
                UpdateSources.Source.GITHUB -> body(403, "0.4.3")
            }
        }
        val found = outcome as UpdateChecker.Outcome.Found
        assertEquals("HTTP 404", found.diagnostics[0].status)
        assertEquals("HTTP 429", found.diagnostics[1].status)
    }

    @Test
    fun incompleteManifestIsTreatedAsFailure() {
        // 缺 versionCode / apk 的清单不能当有效结果，应跳下一个源。
        // Gitee 走外壳（content 里才是清单），所以坏清单也要包一层 base64。
        val broken = JSONObject().put("versionName", "0.4.3").toString()
        val outcome = UpdateChecker.check(400) { source ->
            when (source) {
                UpdateSources.Source.GITEE_API -> giteeWrapper(broken)
                else -> throw IOException("HTTP 500")
            }
        }
        val failure = outcome as UpdateChecker.Outcome.Failure
        assertEquals("所有更新源都不可用", failure.message)
        assertEquals("清单字段不完整", failure.diagnostics[0].status)
    }

    @Test
    fun apkNameWithPathIsRejected() {
        // 防清单把下载指向别的路径。
        val bad = body(403, "0.4.3", apk = "../evil.apk")
        try {
            UpdateChecker.parseManifestBody(UpdateSources.Source.JSDELIVR, bad)
            throw AssertionError("带路径的 apk 名应当抛 IOException")
        } catch (e: IOException) {
            assertEquals("清单 apk 字段不合法", e.message)
        }
    }

    @Test
    fun missingApkCnFallsBackToGitHubOnly() {
        val manifest = UpdateChecker.Manifest(
            versionCode = 403,
            versionName = "0.4.3",
            releasedAt = "2026-11-16",
            apk = "FnCal-Android-0.4.3.apk",
            notes = listOf("x"),
            apkCn = null,
        )
        val targets = UpdateSources.downloadTargets(manifest)
        assertEquals(1, targets.size)
        assertTrue(targets[0].url.endsWith("android-v0.4.3/FnCal-Android-0.4.3.apk"))
        assertNull(UpdateSources.giteeApkUrl(manifest))
    }

    @Test
    fun sourceTagsAreStableForDiagnostics() {
        assertEquals("Gitee", UpdateChecker.sourceTag(UpdateSources.Source.GITEE_API))
        assertEquals("jsDelivr", UpdateChecker.sourceTag(UpdateSources.Source.JSDELIVR))
        assertEquals("GitHub", UpdateChecker.sourceTag(UpdateSources.Source.GITHUB))
    }
    // ---- 0.4.3（§十一 先探后下）：HEAD 探测决定下载地址 ------------------

    private fun manifestWith(cn: String?): UpdateChecker.Manifest =
        UpdateChecker.Manifest(
            versionCode = 403,
            versionName = "0.4.3",
            releasedAt = "2026-11-16",
            apk = "FnCal-Android-0.4.3.apk",
            notes = listOf("x"),
            apkCn = cn,
        )

    @Test
    fun planDownloadKeepsGiteeFirstWhenApkCnIsReachable() {
        val cn = "https://example.test/cn/FnCal-Android-0.4.3.apk"
        val plan = UpdateSources.planDownload(manifestWith(cn)) { true }
        assertEquals(2, plan.size)
        assertEquals(cn, plan[0].url)
        assertTrue(plan[1].url.endsWith("android-v0.4.3/FnCal-Android-0.4.3.apk"))
    }

    @Test
    fun planDownloadDropsDeadApkCn() {
        val cn = "https://example.test/cn/FnCal-Android-0.4.3.apk"
        val probed = mutableListOf<String>()
        val plan = UpdateSources.planDownload(manifestWith(cn)) { url ->
            probed.add(url)
            url != cn
        }
        assertEquals(1, plan.size)
        assertTrue(plan[0].url.endsWith("android-v0.4.3/FnCal-Android-0.4.3.apk"))
        // 死链只探一次，探完就换 GitHub 直链。
        assertEquals(listOf(cn, plan[0].url), probed)
    }

    @Test
    fun planDownloadIsEmptyWhenBothAddressesAreDead() {
        val plan = UpdateSources.planDownload(manifestWith("https://example.test/cn/x.apk")) { false }
        assertTrue(plan.isEmpty())
    }

    @Test
    fun planDownloadProbesGitHubOnlyWithoutApkCn() {
        val probed = mutableListOf<String>()
        val plan = UpdateSources.planDownload(manifestWith(null)) { url ->
            probed.add(url)
            true
        }
        assertEquals(1, probed.size)
        assertEquals(1, plan.size)
        assertEquals(probed[0], plan[0].url)
    }

    @Test
    fun planDownloadTreatsThrowingProbeAsDead() {
        val plan = UpdateSources.planDownload(manifestWith("https://example.test/cn/x.apk")) { url ->
            if (url.contains("example.test")) throw IOException("TLS 断了") else true
        }
        assertEquals(1, plan.size)
        assertTrue(plan[0].url.endsWith("android-v0.4.3/FnCal-Android-0.4.3.apk"))
    }
}
