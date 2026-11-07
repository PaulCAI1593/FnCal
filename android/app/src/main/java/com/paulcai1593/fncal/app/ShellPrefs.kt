package com.paulcai1593.fncal.app

import android.content.Context
import android.content.SharedPreferences

/**
 * 壳自己的少量持久化数据。
 *
 * v0.1.0 只存一个服务器地址（多地址不在范围内），外加探活得到的服务端版本
 * 和「允许自签证书」开关——开关只对已保存的这个地址生效。
 */
object ShellPrefs {

    private const val FILE = "fncal_shell"
    private const val KEY_BASE_URL = "base_url"
    private const val KEY_SERVER_VERSION = "server_version"
    private const val KEY_ALLOW_SELF_SIGNED = "allow_self_signed"

    /** 0.3.5：最近一次刷新服务端版本的时间（毫秒），供排查与节流。 */
    private const val KEY_SERVER_VERSION_AT = "server_version_at"

    /** 0.2.0：更新源（cn = 国内源，direct = 直通），默认国内源。 */
    private const val KEY_UPDATE_SOURCE = "update_source"

    private fun prefs(context: Context): SharedPreferences =
        context.applicationContext.getSharedPreferences(FILE, Context.MODE_PRIVATE)

    fun baseUrl(context: Context): String? = prefs(context).getString(KEY_BASE_URL, null)

    fun setBaseUrl(context: Context, url: String) {
        prefs(context).edit().putString(KEY_BASE_URL, url).apply()
    }

    fun serverVersion(context: Context): String? = prefs(context).getString(KEY_SERVER_VERSION, null)

    fun setServerVersion(context: Context, version: String?) {
        val editor = prefs(context).edit()
        if (version.isNullOrBlank()) {
            editor.remove(KEY_SERVER_VERSION)
        } else {
            editor.putString(KEY_SERVER_VERSION, version)
        }
        editor.apply()
    }

    /** 0.3.5：上次刷新服务端版本的时间；0 表示从未成功刷新过。 */
    fun serverVersionAt(context: Context): Long =
        prefs(context).getLong(KEY_SERVER_VERSION_AT, 0L)

    fun setServerVersionAt(context: Context, millis: Long) {
        prefs(context).edit().putLong(KEY_SERVER_VERSION_AT, millis).apply()
    }

    fun allowSelfSigned(context: Context): Boolean =
        prefs(context).getBoolean(KEY_ALLOW_SELF_SIGNED, false)

    fun setAllowSelfSigned(context: Context, allow: Boolean) {
        prefs(context).edit().putBoolean(KEY_ALLOW_SELF_SIGNED, allow).apply()
    }

    /** 更新源偏好值；调用方用 UpdateSources.Source.fromPref 转成枚举。 */
    fun updateSource(context: Context): String? = prefs(context).getString(KEY_UPDATE_SOURCE, null)

    fun setUpdateSource(context: Context, value: String) {
        prefs(context).edit().putString(KEY_UPDATE_SOURCE, value).apply()
    }

    fun clear(context: Context) {
        prefs(context).edit().clear().apply()
    }
}
