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

    fun allowSelfSigned(context: Context): Boolean =
        prefs(context).getBoolean(KEY_ALLOW_SELF_SIGNED, false)

    fun setAllowSelfSigned(context: Context, allow: Boolean) {
        prefs(context).edit().putBoolean(KEY_ALLOW_SELF_SIGNED, allow).apply()
    }

    fun clear(context: Context) {
        prefs(context).edit().clear().apply()
    }
}
