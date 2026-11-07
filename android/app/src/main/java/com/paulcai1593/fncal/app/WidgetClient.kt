package com.paulcai1593.fncal.app

import android.content.Context
import java.io.IOException
import java.net.HttpURLConnection
import java.net.URL
import java.security.cert.X509Certificate
import javax.net.ssl.HttpsURLConnection
import javax.net.ssl.SSLContext
import javax.net.ssl.X509TrustManager

/**
 * 0.3.0 卡片取数：`GET {base}/api/widget/v1/summary`（只读 Bearer，0.6.0 接口）。
 *
 * 结果分五类，调用方据此决定「换缓存 / 只更新时间 / 保留缓存并提示」。
 * 这里不做重试：429 与 401 重试也没用，网络失败留给下一次 30 分钟周期。
 */
object WidgetClient {

    private const val TIMEOUT_MS = 10_000

    sealed class Result {
        data class Ok(val json: String, val etag: String?) : Result()
        object NotModified : Result()
        object Unauthorized : Result()
        object RateLimited : Result()
        data class Failed(val reason: String) : Result()
    }

    fun summary(
        context: Context,
        token: String,
        from: Long,
        to: Long,
        etag: String?,
    ): Result {
        val base = ShellPrefs.baseUrl(context) ?: return Result.Failed("no-base")
        val url = base.trimEnd('/') +
            "/api/widget/v1/summary?from=" + CalKit.isoDate(from) +
            "&to=" + CalKit.isoDate(to)
        var connection: HttpURLConnection? = null
        return try {
            val opened = URL(url).openConnection()
            if (opened is HttpsURLConnection && ShellPrefs.allowSelfSigned(context)) {
                opened.sslSocketFactory =
                    trustAllContext().socketFactory as javax.net.ssl.SSLSocketFactory
                opened.hostnameVerifier = { _, _ -> true }
            }
            connection = opened as HttpURLConnection
            connection.requestMethod = "GET"
            connection.connectTimeout = TIMEOUT_MS
            connection.readTimeout = TIMEOUT_MS
            connection.setRequestProperty("Authorization", "Bearer $token")
            connection.setRequestProperty("Accept", "application/json")
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
