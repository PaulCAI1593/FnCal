package com.paulcai1593.fncal.app

import android.app.PendingIntent
import android.appwidget.AppWidgetManager
import android.appwidget.AppWidgetProvider
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.os.Bundle
import android.widget.RemoteViews

/**
 * 0.3.0 五款桌面卡片的共同逻辑。
 *
 * 每款只声明自己的画法、默认尺寸与深链目标；取数、刷新、点击都走同一套。
 * `updatePeriodMillis=0`（见 res/xml/widget_*_info.xml）：系统闹钟不刷新，
 * 改由 WorkManager 每 30 分钟 + 添加卡片/手动刷新/开机/改时间时刷新。
 */
abstract class FnCalWidgetProvider : AppWidgetProvider() {

    abstract val widgetKind: WidgetKind
    abstract val defaultWidthDp: Int
    abstract val defaultHeightDp: Int

    /** 点卡片要打开的视图：month / 4day / day / agenda（Web 端 hash 深链）。 */
    abstract val linkView: String

    override fun onUpdate(
        context: Context,
        appWidgetManager: AppWidgetManager,
        appWidgetIds: IntArray,
    ) {
        for (id in appWidgetIds) updateWidget(context, appWidgetManager, id)
    }

    override fun onAppWidgetOptionsChanged(
        context: Context,
        appWidgetManager: AppWidgetManager,
        appWidgetId: Int,
        newOptions: Bundle,
    ) {
        // 拉大/缩小时按新尺寸重画；位图不缩放，字才不会糊。
        updateWidget(context, appWidgetManager, appWidgetId)
    }

    override fun onEnabled(context: Context) {
        super.onEnabled(context)
        WidgetScheduler.ensurePeriodic(context)
        WidgetScheduler.refreshNow(context)
    }

    override fun onDisabled(context: Context) {
        super.onDisabled(context)
        WidgetScheduler.cancelIfUnused(context)
    }

    override fun onReceive(context: Context, intent: Intent) {
        super.onReceive(context, intent)
        if (intent.action == ACTION_REFRESH) {
            WidgetScheduler.refreshNow(context)
            updateAll(context)
        }
    }

    private fun updateWidget(
        context: Context,
        manager: AppWidgetManager,
        appWidgetId: Int,
    ) {
        val options = manager.getAppWidgetOptions(appWidgetId)
        val widthDp = options.getInt(AppWidgetManager.OPTION_APPWIDGET_MIN_WIDTH, defaultWidthDp)
        val heightDp = options.getInt(AppWidgetManager.OPTION_APPWIDGET_MIN_HEIGHT, defaultHeightDp)
        val density = context.resources.displayMetrics.density
        val bitmap = WidgetRenderer(context, widgetKind).render(
            (widthDp * density).toInt(),
            (heightDp * density).toInt(),
        )
        val views = RemoteViews(context.packageName, R.layout.widget_card)
        views.setImageViewBitmap(R.id.widget_image, bitmap)
        views.setOnClickPendingIntent(
            R.id.widget_root,
            clickIntent(context, linkView, appWidgetId),
        )
        manager.updateAppWidget(appWidgetId, views)
    }

    companion object {
        const val ACTION_REFRESH = "com.paulcai1593.fncal.app.action.WIDGET_REFRESH"

        private val PROVIDERS: Array<Class<out FnCalWidgetProvider>> = arrayOf(
            MiniMonthWidgetProvider::class.java,
            DayAgendaWidgetProvider::class.java,
            MonthWidgetProvider::class.java,
            FourDayWidgetProvider::class.java,
            AgendaListWidgetProvider::class.java,
        )

        /** 点卡片：没令牌进「关于 → 桌面卡片」，有令牌进主界面并带视图与日期。 */
        fun clickIntent(context: Context, linkView: String, appWidgetId: Int): PendingIntent {
            val intent = if (!WidgetPrefs.hasToken(context)) {
                Intent(context, AboutActivity::class.java).apply {
                    flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP
                }
            } else {
                Intent(context, MainActivity::class.java).apply {
                    putExtra(MainActivity.EXTRA_VIEW, linkView)
                    putExtra(MainActivity.EXTRA_DATE, CalKit.isoDate(System.currentTimeMillis()))
                    flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP
                }
            }
            val flags = PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
            return PendingIntent.getActivity(context, appWidgetId, intent, flags)
        }

        /** 数据变了之后重画所有还挂着的卡片。 */
        fun updateAll(context: Context) {
            val manager = AppWidgetManager.getInstance(context)
            for (provider in PROVIDERS) {
                val ids = manager.getAppWidgetIds(ComponentName(context, provider))
                if (ids.isEmpty()) continue
                val instance = provider.getDeclaredConstructor().newInstance()
                for (id in ids) {
                    val options = manager.getAppWidgetOptions(id)
                    val widthDp = options.getInt(
                        AppWidgetManager.OPTION_APPWIDGET_MIN_WIDTH,
                        instance.defaultWidthDp,
                    )
                    val heightDp = options.getInt(
                        AppWidgetManager.OPTION_APPWIDGET_MIN_HEIGHT,
                        instance.defaultHeightDp,
                    )
                    val density = context.resources.displayMetrics.density
                    val bitmap = WidgetRenderer(context, instance.widgetKind).render(
                        (widthDp * density).toInt(),
                        (heightDp * density).toInt(),
                    )
                    val views = RemoteViews(context.packageName, R.layout.widget_card)
                    views.setImageViewBitmap(R.id.widget_image, bitmap)
                    views.setOnClickPendingIntent(
                        R.id.widget_root,
                        clickIntent(context, instance.linkView, id),
                    )
                    manager.updateAppWidget(id, views)
                }
            }
        }

        /** 是否还有任意一款卡片挂在桌面（决定要不要停掉周期任务）。 */
        fun anyWidgets(context: Context): Boolean {
            val manager = AppWidgetManager.getInstance(context)
            for (provider in PROVIDERS) {
                if (manager.getAppWidgetIds(ComponentName(context, provider)).isNotEmpty()) {
                    return true
                }
            }
            return false
        }
    }
}

class MiniMonthWidgetProvider : FnCalWidgetProvider() {
    override val widgetKind = WidgetKind.MINI_MONTH
    override val defaultWidthDp = 110
    override val defaultHeightDp = 110
    override val linkView = "month"
}

class DayAgendaWidgetProvider : FnCalWidgetProvider() {
    override val widgetKind = WidgetKind.DAY_AGENDA
    override val defaultWidthDp = 110
    override val defaultHeightDp = 110
    override val linkView = "day"
}

class MonthWidgetProvider : FnCalWidgetProvider() {
    override val widgetKind = WidgetKind.MONTH
    override val defaultWidthDp = 250
    override val defaultHeightDp = 250
    override val linkView = "month"
}

class FourDayWidgetProvider : FnCalWidgetProvider() {
    override val widgetKind = WidgetKind.FOUR_DAY
    override val defaultWidthDp = 250
    override val defaultHeightDp = 250
    override val linkView = "4day"
}

class AgendaListWidgetProvider : FnCalWidgetProvider() {
    override val widgetKind = WidgetKind.AGENDA_LIST
    override val defaultWidthDp = 250
    override val defaultHeightDp = 250
    override val linkView = "agenda"
}
