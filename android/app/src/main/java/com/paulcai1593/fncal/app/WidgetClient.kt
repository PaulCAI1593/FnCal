package com.paulcai1593.fncal.app

import android.content.Context
import android.webkit.CookieManager
import org.json.JSONObject
import java.io.IOException
import java.net.HttpURLConnection
import java.net.URL
import java.security.cert.X509Certificate
import javax.net.ssl.HttpsURLConnection
import javax.net.ssl.SSLContext
import javax.net.ssl.X509TrustManager

/**
 * 0.3.0 卡片取数：`GET {base}/api/widget/v1/summary`。
 *
 * 0.6.2 §F 起不再单独发令牌——卡片跟随 App 登录态：
 * 从 `CookieManager` 取壳内 WebView 的会话 Cookie，按 `Cookie: <cookie>` 发送。
 * 取不到 Cookie、或服务端回 401（会话被撤销／过期）→ `Unauthorized`，
 * 卡片显示「打开 FnCal 登录」，点击进 App 重新登录。
 *
 * 这里不做重试：429 与 401 重试也没用，网络失败留给下一次 30 分钟周期。
 */
object WidgetClient {

    private const val TIMEOUT_MS = 10_000
    private const val VERSION = "0.3.4"

    sealed class Result {
        data class Ok(val json: String, val etag: String?) : Result()
        object NotModified : Result()
        object Unauthorized : Result()
        object RateLimited : Result()
        data class Failed(val reason: String) : Result()
    }

    fun userAgent(): String = "FnCalWidget/$VERSION${DeviceName.suffix()}"

    /**
     * 壳内是否已有登录 Cookie。
     *
     * 后台进程里 WebView 可能还没初始化：这里必须整段 try/catch，
     * 失败按「未登录」处理，绝不崩卡片进程。
     */
    fun sessionCookie(context: Context): String {
        val base = ShellPrefs.baseUrl(context) ?: return ""
        return try {
            val cookie = CookieManager.getInstance().getCookie(base)
            cookie.orEmpty().trim()
        } catch (e: Exception) {
            ""
        }
    }

    fun hasSession(context: Context): Boolean {
        val cookie = sessionCookie(context)
        return cookie.isNotEmpty() && cookie.contains("caldav_session")
    }

    fun summary(
        context: Context,
        from: Long,
        to: Long,
        etag: String?,
    ): Result {
        val base = ShellPrefs.baseUrl(context) ?: return Result.Failed("no-base")
        val cookie = sessionCookie(context)
        if (cookie.isEmpty()) return Result.Unauthorized
        val url = base.trimEnd('/') +
            "/api/widget/v1/summary?from=" + CalKit.isoDate(from) +
            "&to=" + CalKit.isoDate(to)
        var connection: HttpURLConnection? = null
        return try {
            connection = prepare(context, url, cookie)
            if (!etag.isNullOrBlank()) connection.setRequestProperty("If-None-Match", etag)
            when (val code = connection.responseCode) {
                200 -> {
                    val body = connection.inputStream.bufferedReader(Charsets.UTF_8)
                        .use { it.readText() }
                    Result.Ok(body, connection.getHeaderField("ETag"))
                }

                304 -> Result.NotModified
                401 -> Result.Unauthorized
                429 -> Result.RateLimited
                else -> Result.Failed("http-$code")
            }
        } catch (e: IOException) {
            Result.Failed("network")
        } catch (e: Exception) {
            Result.Failed("network")
        } finally {
            connection?.disconnect()
        }
    }

    /**
     * 0.3.4 §8：读网页设置里的「每周开始日」——`GET /api/v1/kv/cal:settings`。
     *
     * 只认 `value.weekStartsOn` 的 0（周日）/ 1（周一）。没写过（404）、网络失败、
     * JSON 解析失败都返回 null：调用方保留上次的值，这次请求失败**不得**让整次
     * 卡片刷新失败。所以它不走 [Result]，也从不抛异常。
     */
    fun weekStartsOn(context: Context): Int? {
        val base = ShellPrefs.baseUrl(context) ?: return null
        val cookie = sessionCookie(context)
        if (cookie.isEmpty()) return null
        val url = base.trimEnd('/') + "/api/v1/kv/cal:settings"
        var connection: HttpURLConnection? = null
        return try {
            connection = prepare(context, url, cookie)
            if (connection.responseCode != 200) return null
            val body = connection.inputStream.bufferedReader(Charsets.UTF_8).use { it.readText() }
            val raw = JSONObject(body).optJSONObject("value")?.optInt("weekStartsOn", -1)
            if (raw == 0 || raw == 1) raw else null
        } catch (e: Exception) {
            null
        } finally {
            connection?.disconnect()
        }
    }

    /** 建连与公共头：Cookie、UA、Accept，以及「用户允许自签证书」时的放行。 */
    private fun prepare(context: Context, url: String, cookie: String): HttpURLConnection {
        val opened = URL(url).openConnection()
        if (opened is HttpsURLConnection && ShellPrefs.allowSelfSigned(context)) {
            opened.sslSocketFactory =
                trustAllContext().socketFactory as javax.net.ssl.SSLSocketFactory
            opened.hostnameVerifier = javax.net.ssl.HostnameVerifier { _, _ -> true }
        }
        return (opened as HttpURLConnection).apply {
            requestMethod = "GET"
            connectTimeout = TIMEOUT_MS
            readTimeout = TIMEOUT_MS
            setRequestProperty("Cookie", cookie)
            setRequestProperty("User-Agent", userAgent())
            setRequestProperty("Accept", "application/json")
        }
    }

    /** 与地址页探活同一个口径：只在用户显式允许自签证书时放行。 */
    private fun trustAllContext(): SSLContext {
        val trustAll = object : X509TrustManager {
            override fun checkClientTrusted(chain: Array<out X509Certificate>?, authType: String?) =
                Unit

            override fun checkServerTrusted(chain: Array<out X509Certificate>?, authType: String?) =
                Unit

            override fun getAcceptedIssuers(): Array<X509Certificate> = emptyArray()
        }
        val context = SSLContext.getInstance("TLS")
        context.init(null, arrayOf(trustAll), null)
        return context
    }
}
