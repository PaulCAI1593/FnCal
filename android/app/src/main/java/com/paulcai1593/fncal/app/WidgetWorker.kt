package com.paulcai1593.fncal.app

import android.content.Context
import androidx.work.Worker
import androidx.work.WorkerParameters

/**
 * 后台刷新一次卡片数据，然后把五款卡片都重画。
 *
 * 失败也返回 success：失败信息已经写进 [WidgetPrefs.lastError]，
 * 卡片会显示「上次更新 HH:mm」；返回 retry 只会让 WorkManager 反复重试同一个错令牌。
 */
class WidgetWorker(
    appContext: Context,
    params: WorkerParameters,
) : Worker(appContext, params) {

    override fun doWork(): Result {
        val context = applicationContext
        if (WidgetPrefs.hasToken(context)) {
            WidgetRepository.refresh(context)
        }
        FnCalWidgetProvider.updateAll(context)
        return Result.success()
    }
}
