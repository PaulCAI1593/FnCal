package com.paulcai1593.fncal.app

import android.content.Context

/**
 * 0.3.0 卡片数据：取数 → 落缓存 → 刷新卡片。
 *
 * 0.6.2 §F：不再单独发令牌，卡片跟随 App 登录态（会话 Cookie）。
 * 范围：当月 1 日到 +45 天（含当天，符合接口的 `from`/`to` 口径）。
 * 失败语义：401／没有登录 Cookie 记 `unauthorized`（卡片提示重新登录）、
 * 网络失败记 `network`，两者都保留旧缓存；429 只跳过本次（限流不是错误）。
 */
object WidgetRepository {

    /** 范围文档 A2：当月 1 日到 +45 天。 */
    const val RANGE_DAYS = 45

    fun signedIn(context: Context): Boolean = WidgetClient.hasSession(context)

    /** 拉一次并落盘；返回是否拿到可用数据（304 也算成功）。 */
    fun refresh(context: Context): Boolean {
        if (!WidgetClient.hasSession(context)) {
            WidgetPrefs.saveError(context, "unauthorized")
            return false
        }
        val now = System.currentTimeMillis()
        val from = CalKit.monthStart(now)
        val to = CalKit.addDays(from, RANGE_DAYS)
        val ok = when (val result = WidgetClient.summary(context, from, to, WidgetPrefs.etag(context))) {
            is WidgetClient.Result.Ok -> {
                WidgetPrefs.saveSuccess(context, result.json, result.etag, now)
                true
            }

            WidgetClient.Result.NotModified -> {
                WidgetPrefs.saveNotModified(context, now)
                true
            }

            WidgetClient.Result.Unauthorized -> {
                WidgetPrefs.saveError(context, "unauthorized")
                false
            }

            WidgetClient.Result.RateLimited -> false

            is WidgetClient.Result.Failed -> {
                WidgetPrefs.saveError(context, result.reason)
                false
            }
        }
        // 0.3.4 §8：顺带同步「每周开始日」。这条请求失败只是保留上次的值，
        // 不影响上面的取数结果，也不会让卡片显示错误。
        WidgetClient.weekStartsOn(context)?.let { WidgetPrefs.saveWeekStartsOn(context, it) }
        return ok
    }
}
