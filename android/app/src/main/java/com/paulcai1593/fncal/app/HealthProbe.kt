package com.paulcai1593.fncal.app

import org.json.JSONObject
import java.net.ConnectException
import java.net.HttpURLConnection
import java.net.SocketTimeoutException
import java.net.URL
import java.net.UnknownHostException
import java.security.cert.X509Certificate
import javax.net.ssl.HostnameVerifier
import javax.net.ssl.HttpsURLConnection
import javax.net.ssl.SSLContext
import javax.net.ssl.SSLException
import javax.net.ssl.SSLSocketFactory
import javax.net.ssl.X509TrustManager

/**
 * 0.3.5：地址页与关于页共用一套「服务端是否在线」探活。
 *
 * 以前只有地址页会写服务端版本，升级 fpk 后关于页一直显示旧值；
 * 现在两处走同一个实现，关于页每次打开都能刷新。
 *
 * 调用方负责放在后台线程：这里直接做网络请求。
 */
object HealthProbe {

    /** 连接与读取各 6 秒（地址页旧实现的 10 秒在这里统一收紧）。 */
    private const val TIMEOUT_MS = 6_000

    enum class Error { CERT, TIMEOUT, REFUSED, NOT_FNCAL, HTTP, OTHER }

    class ProbeException(val error: Error, val status: Int = 0) : Exception(error.name)

    data class Health(val ok: Boolean, val version: String)

    fun probe(baseUrl: String, allowSelfSigned: Boolean): Result<Health> {
        val connection = try {
            val url = URL(baseUrl.trimEnd('/') + "/api/health")
            url.openConnection() as HttpURLConnection
        } catch (e: Exception) {
            return Result.failure(ProbeException(Error.OTHER))
        }
        return try {
            connection.connectTimeout = TIMEOUT_MS
            connection.readTimeout = TIMEOUT_MS
            connection.requestMethod = "GET"
            connection.setRequestProperty("Accept", "application/json")
            if (allowSelfSigned && connection is HttpsURLConnection) {
                connection.sslSocketFactory =
                    trustAllContext().socketFactory as SSLSocketFactory
                connection.hostnameVerifier = HostnameVerifier { _, _ -> true }
            }
            val status = connection.responseCode
            if (status !in 200..299) {
                Result.failure(ProbeException(Error.HTTP, status))
            } else {
                val body = connection.inputStream
                    ?.bufferedReader()
                    ?.use { it.readText() }
                    .orEmpty()
                Result.success(parse(body))
            }
        } catch (e: ProbeException) {
            Result.failure(e)
        } catch (e: SSLException) {
            Result.failure(ProbeException(Error.CERT))
        } catch (e: SocketTimeoutException) {
            Result.failure(ProbeException(Error.TIMEOUT))
        } catch (e: ConnectException) {
            Result.failure(ProbeException(Error.REFUSED))
        } catch (e: UnknownHostException) {
            Result.failure(ProbeException(Error.REFUSED))
        } catch (e: Exception) {
            Result.failure(ProbeException(Error.OTHER))
        } finally {
            connection.disconnect()
        }
    }

    private fun parse(body: String): Health {
        val json = JSONObject(body)
        if (!json.optBoolean("ok", false)) throw ProbeException(Error.NOT_FNCAL)
        return Health(true, json.optString("version", ""))
    }

    /** 自签证书时探活也放行——否则「允许自签」只对 WebView 生效，探活仍然失败。 */
    private fun trustAllContext(): SSLContext {
        val trustAll = object : X509TrustManager {
            override fun checkClientTrusted(chain: Array<out X509Certificate>?, authType: String?) = Unit
            override fun checkServerTrusted(chain: Array<out X509Certificate>?, authType: String?) = Unit
            override fun getAcceptedIssuers(): Array<X509Certificate> = emptyArray()
        }
        val context = SSLContext.getInstance("TLS")
        context.init(null, arrayOf(trustAll), null)
        return context
    }
}
