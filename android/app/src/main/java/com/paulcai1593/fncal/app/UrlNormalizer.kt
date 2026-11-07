package com.paulcai1593.fncal.app

import java.net.URI

/**
 * 地址规范化：纯函数、无 Android 依赖，便于单测。
 *
 * 规则：
 * 1. 去首尾空白；空白、非 ASCII（含中文）直接报错。
 * 2. 没写协议时补协议：host 是 localhost / 127.x / 10.x / 192.168.x / 172.16-31.x
 *    用 http，其它用 https。
 * 3. 只接受 http / https。
 * 4. 去尾部 `/`；保留路径前缀（反代子路径）；保留端口。
 * 5. 空、无 host、带空格、带中文、非法端口都给错误码。
 */
object UrlNormalizer {

    enum class Error {
        EMPTY,
        WHITESPACE,
        NON_ASCII,
        BAD_SCHEME,
        NO_HOST,
        INVALID,
    }

    data class Result(val url: String?, val error: Error?) {
        val ok: Boolean get() = url != null
    }

    fun normalize(raw: String?): Result {
        val input = raw?.trim().orEmpty()
        if (input.isEmpty()) return Result(null, Error.EMPTY)
        if (input.any { it.isWhitespace() }) return Result(null, Error.WHITESPACE)
        if (input.any { it.code > 127 }) return Result(null, Error.NON_ASCII)

        var candidate = input
        if (!candidate.contains("://")) {
            val hostPart = candidate
                .substringBefore('/')
                .substringBefore('?')
                .substringBefore('#')
            val scheme = if (isLocalHost(hostPart)) "http" else "https"
            candidate = "$scheme://$candidate"
        }

        val uri = try {
            URI(candidate)
        } catch (e: Exception) {
            return Result(null, Error.INVALID)
        }

        val scheme = uri.scheme?.lowercase() ?: return Result(null, Error.BAD_SCHEME)
        if (scheme != "http" && scheme != "https") return Result(null, Error.BAD_SCHEME)

        val host = uri.host
        if (host.isNullOrBlank()) return Result(null, Error.NO_HOST)

        // v0.1.0 不做带账号密码的地址。
        if (!uri.userInfo.isNullOrEmpty()) return Result(null, Error.INVALID)

        val port = uri.port
        if (port != -1 && (port < 1 || port > 65535)) return Result(null, Error.INVALID)

        val path = uri.rawPath.orEmpty().trimEnd('/')
        val query = uri.rawQuery
        val queryPart = if (query.isNullOrEmpty()) "" else "?$query"

        val url = buildString {
            append(scheme).append("://").append(host)
            if (port != -1) append(':').append(port)
            append(path)
            append(queryPart)
        }
        return Result(url, null)
    }

    private fun isLocalHost(hostPort: String): Boolean {
        val host = hostPort.substringBefore(':').lowercase()
        if (host == "localhost") return true
        if (host.startsWith("127.")) return true
        if (host.startsWith("10.")) return true
        if (host.startsWith("192.168.")) return true
        if (host.startsWith("172.")) {
            val second = host.split('.').getOrNull(1)?.toIntOrNull() ?: return false
            return second in 16..31
        }
        return false
    }
}
