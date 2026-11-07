package com.paulcai1593.fncal.app

import android.content.Context
import android.content.SharedPreferences

/**
 * 0.3.0 桌面卡片的本地缓存（范围文档 A2）。
 *
 * 0.6.2 §F 起不再保存任何令牌：卡片跟随 App 登录态，登录 Cookie 由 WebView 的
 * `CookieManager` 持有（本类既不读也不写 Cookie、更不落盘明文）。
 * 这里只存最近一次成功的摘要 JSON 与它的 ETag/时间；网络失败时卡片继续用缓存，
 * 并显示「上次更新 HH:mm」。
 */
object WidgetPrefs {

    private const val FILE = "fncal_widget"
    private const val KEY_CACHE = "cache_json"
    private const val KEY_ETAG = "cache_etag"
    private const val KEY_UPDATED = "last_updated"
    private const val KEY_ERROR = "last_error"
    private const val KEY_WEEK_START = "week_starts_on"

    private fun prefs(context: Context): SharedPreferences =
        context.applicationContext.getSharedPreferences(FILE, Context.MODE_PRIVATE)

    fun cache(context: Context): String? = prefs(context).getString(KEY_CACHE, null)

    fun etag(context: Context): String? = prefs(context).getString(KEY_ETAG, null)

    fun lastUpdated(context: Context): Long = prefs(context).getLong(KEY_UPDATED, 0L)

    fun lastError(context: Context): String? = prefs(context).getString(KEY_ERROR, null)

    /**
     * 0.3.4 §8：网页设置里的「每周开始日」——0 = 周日（默认），1 = 周一。
     * 渲染器没有 Context，读出来随快照一起带给它。
     */
    fun weekStartsOn(context: Context): Int =
        if (prefs(context).getInt(KEY_WEEK_START, 0) == 1) 1 else 0

    fun saveWeekStartsOn(context: Context, value: Int) {
        prefs(context).edit().putInt(KEY_WEEK_START, if (value == 1) 1 else 0).apply()
    }

    /** 200：换掉缓存与 ETag，并记下本次成功时间。 */
    fun saveSuccess(context: Context, json: String, etag: String?, at: Long) {
        val editor = prefs(context).edit()
        editor.putString(KEY_CACHE, json)
        if (etag.isNullOrBlank()) editor.remove(KEY_ETAG) else editor.putString(KEY_ETAG, etag)
        editor.putLong(KEY_UPDATED, at)
        editor.remove(KEY_ERROR)
        editor.apply()
    }

    /** 304：内容没变，只更新时间、清掉上次错误。 */
    fun saveNotModified(context: Context, at: Long) {
        prefs(context).edit()
            .putLong(KEY_UPDATED, at)
            .remove(KEY_ERROR)
            .apply()
    }

    /** 失败：保留缓存，只记错误原因（卡片据此显示上次更新时间 / 重新登录提示）。 */
    fun saveError(context: Context, message: String?) {
        prefs(context).edit().putString(KEY_ERROR, message ?: "").apply()
    }

    fun clear(context: Context) {
        prefs(context).edit().clear().apply()
    }
}
