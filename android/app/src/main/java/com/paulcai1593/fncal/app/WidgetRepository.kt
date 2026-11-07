package com.paulcai1593.fncal.app

import android.content.Context

/**
 * 0.3.0 卡片数据：取数 → 落缓存 → 刷新卡片。Worker 与「保存并测试」共用这里。
 *
 * 范围：当月 1 日到 +45 天（含当天，符合 0.6.0 接口的 `from`/`to` 口径）。
 * 失败语义：401 记「令牌无效」、网络失败记「连不上」，两者都保留旧缓存；
 * 429 只跳过本次（限流不是错误，不该在卡片上留下红色状态）。
 */
object WidgetRepository {

    /** 范围文档 A2：当月 1 日到 +45 天。 */
    const val RANGE_DAYS = 45

    data class TestOutcome(
        val connected: Boolean,
        val todayCount: Int = 0,
        /** `invalid` / `network` / `none`（没有令牌）。 */
        val reason: String? = null,
    )

    /** 拉一次并落盘；返回是否拿到可用数据（304 也算成功）。 */
    fun refresh(context: Context): Boolean {
        val token = WidgetPrefs.token(context) ?: return false
        val now = System.currentTimeMillis()
        val from = CalKit.monthStart(now)
        val to = CalKit.addDays(from, RANGE_DAYS)
        return when (val result = WidgetClient.summary(context, token, from, to, WidgetPrefs.etag(context))) {
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
    }

    /** A1 的「保存并测试」：只取今天，回答「今天几条」。 */
    fun testToday(context: Context, token: String): TestOutcome {
        val today = CalKit.dayStart(System.currentTimeMillis())
        val result = WidgetClient.summary(context, token, today, today, null)
        return when (result) {
            is WidgetClient.Result.Ok -> {
                val snapshot = WidgetSnapshot.parse(result.json)
                val count = snapshot
                    ?.eventsOn(today, CalKit.dayEnd(today))
                    ?.size ?: 0
                WidgetPrefs.saveSuccess(context, result.json, result.etag, System.currentTimeMillis())
                TestOutcome(true, count, null)
            }

            WidgetClient.Result.NotModified -> TestOutcome(true, 0, null)
            WidgetClient.Result.Unauthorized -> TestOutcome(false, reason = "invalid")
            WidgetClient.Result.RateLimited -> TestOutcome(false, reason = "network")
            is WidgetClient.Result.Failed -> TestOutcome(false, reason = "network")
        }
    }
}
