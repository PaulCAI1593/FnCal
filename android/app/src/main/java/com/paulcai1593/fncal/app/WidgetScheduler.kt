package com.paulcai1593.fncal.app

import android.content.Context
import androidx.work.Constraints
import androidx.work.ExistingPeriodicWorkPolicy
import androidx.work.ExistingWorkPolicy
import androidx.work.NetworkType
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.PeriodicWorkRequestBuilder
import androidx.work.WorkManager
import java.util.concurrent.TimeUnit

/**
 * 卡片刷新排期。
 *
 * - 周期：30 分钟（WorkManager 的最小周期是 15 分钟，这里取 30 分钟，对齐范围文档）。
 * - 触发点：添加卡片、启动应用、点刷新、开机/改时间/升级；都走 [refreshNow]。
 * - 只挂了一款卡片时也会排；最后一张卡片移除时 [cancelIfUnused] 停掉，避免白耗电。
 */
object WidgetScheduler {

    private const val UNIQUE_PERIODIC = "fncal-widget-refresh-periodic"
    private const val UNIQUE_NOW = "fncal-widget-refresh-now"
    private const val INTERVAL_MINUTES = 30L

    fun ensurePeriodic(context: Context) {
        val request = PeriodicWorkRequestBuilder<WidgetWorker>(INTERVAL_MINUTES, TimeUnit.MINUTES)
            .setConstraints(connected())
            .build()
        WorkManager.getInstance(context).enqueueUniquePeriodicWork(
            UNIQUE_PERIODIC,
            ExistingPeriodicWorkPolicy.UPDATE,
            request,
        )
    }

    fun refreshNow(context: Context) {
        if (ShellPrefs.baseUrl(context).isNullOrBlank()) {
            // 没配服务器时刷新只会画占位图，跳过网络与耗电。
            FnCalWidgetProvider.updateAll(context)
            return
        }
        val request = OneTimeWorkRequestBuilder<WidgetWorker>()
            .setConstraints(connected())
            .build()
        WorkManager.getInstance(context).enqueueUniqueWork(
            UNIQUE_NOW,
            ExistingWorkPolicy.REPLACE,
            request,
        )
    }

    fun cancelIfUnused(context: Context) {
        if (FnCalWidgetProvider.anyWidgets(context)) return
        val work = WorkManager.getInstance(context)
        work.cancelUniqueWork(UNIQUE_PERIODIC)
        work.cancelUniqueWork(UNIQUE_NOW)
    }

    private fun connected(): Constraints = Constraints.Builder()
        .setRequiredNetworkType(NetworkType.CONNECTED)
        .build()
}
