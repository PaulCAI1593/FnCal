package com.paulcai1593.fncal.app

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent

/**
 * 开机、改时间、改时区、应用升级之后重新排期并刷新一次。
 *
 * 周期任务在设备重启后会丢，所以必须有这条兜底。
 */
class WidgetRefreshReceiver : BroadcastReceiver() {

    override fun onReceive(context: Context, intent: Intent) {
        when (intent.action) {
            Intent.ACTION_BOOT_COMPLETED,
            Intent.ACTION_TIME_CHANGED,
            Intent.ACTION_TIMEZONE_CHANGED,
            Intent.ACTION_MY_PACKAGE_REPLACED,
            -> {
                if (!FnCalWidgetProvider.anyWidgets(context)) return
                WidgetScheduler.ensurePeriodic(context)
                WidgetScheduler.refreshNow(context)
            }
        }
    }
}
