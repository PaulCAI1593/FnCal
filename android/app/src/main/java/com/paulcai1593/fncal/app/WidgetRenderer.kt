package com.paulcai1593.fncal.app

import android.content.Context
import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Paint
import android.graphics.Path
import android.graphics.RectF
import android.graphics.Typeface
import android.text.TextPaint
import android.text.TextUtils
import androidx.core.content.ContextCompat
import java.util.Calendar

/** 0.3.0 的五款桌面卡片。每款只决定画法，数据都来自同一份摘要缓存。 */
enum class WidgetKind {
    MINI_MONTH,
    DAY_AGENDA,
    MONTH,
    FOUR_DAY,
    AGENDA_LIST,
}

/**
 * 整张卡片画成一张位图，交给 RemoteViews 的单个 ImageView（范围文档 A4）。
 *
 * 为什么整卡位图：五款布局差异大（网格 / 时间轴 / 列表），用 RemoteViews 逐控件
 * 摆会受各厂商 Launcher 的尺寸与内距影响，画布直接按 AppWidgetManager 给的实际
 * 尺寸与 density 绘制，字号与间距可精确控制。
 *
 * 约束：正文不小于 10sp、标题不小于 12sp；任何一行只画一次省略号，不出现半个字。
 */
class WidgetRenderer(private val context: Context, private val kind: WidgetKind) {

    private val density = context.resources.displayMetrics.density

    private val colorBg = ContextCompat.getColor(context, R.color.widget_bg)
    private val colorBorder = ContextCompat.getColor(context, R.color.widget_border)
    private val colorText = ContextCompat.getColor(context, R.color.text)
    private val colorText2 = ContextCompat.getColor(context, R.color.text_2)
    private val colorText3 = ContextCompat.getColor(context, R.color.text_3)
    private val colorAccent = ContextCompat.getColor(context, R.color.accent)
    private val colorOnAccent = ContextCompat.getColor(context, R.color.accent_contrast)
    private val colorWeekend = ContextCompat.getColor(context, R.color.widget_weekend)

    private val medium = Typeface.create("sans-serif-medium", Typeface.NORMAL)

    fun render(widthPx: Int, heightPx: Int): Bitmap {
        val width = widthPx.coerceAtLeast(1)
        val height = heightPx.coerceAtLeast(1)
        val bitmap = Bitmap.createBitmap(width, height, Bitmap.Config.ARGB_8888)
        val sketch = Sketch(Canvas(bitmap), width.toFloat(), height.toFloat())
        sketch.background()

        val snapshot = WidgetSnapshot.parse(WidgetPrefs.cache(context))
        // 0.6.2 §F：卡片跟随 App 登录态。未登录、或会话被撤销（401 → unauthorized）时
        // 不再画旧日程，避免把过期数据当成现在的安排。
        val signedIn = WidgetClient.hasSession(context)
        val revoked = WidgetPrefs.lastError(context) == "unauthorized"
        if (!signedIn || revoked || snapshot == null) {
            sketch.placeholder()
            return bitmap
        }

        when (kind) {
            WidgetKind.MINI_MONTH -> sketch.miniMonth(snapshot)
            WidgetKind.DAY_AGENDA -> sketch.dayAgenda(snapshot)
            WidgetKind.MONTH -> sketch.month(snapshot)
            WidgetKind.FOUR_DAY -> sketch.fourDay(snapshot)
            WidgetKind.AGENDA_LIST -> sketch.agendaList(snapshot)
        }
        sketch.staleFooter()
        return bitmap
    }

    private fun sp(value: Float): Float = value * density

    private fun dp(value: Float): Float = value * density

    private fun paint(sizeSp: Float, color: Int, mediumWeight: Boolean = false): TextPaint =
        TextPaint(Paint.ANTI_ALIAS_FLAG).apply {
            textSize = sp(sizeSp)
            this.color = color
            if (mediumWeight) typeface = medium
        }

    /**
     * 一个画布上的绘制上下文。持有所需的画笔，避免每次 new；所有尺寸都从
     * 实际宽高推导，因此 2×2 与 4×4 用同一套代码。
     */
    private inner class Sketch(
        private val canvas: Canvas,
        private val w: Float,
        private val h: Float,
    ) {

        private val path = Path()
        private val rect = RectF()

        fun background() {
            val radius = dp(16f)
            path.reset()
            rect.set(0f, 0f, w, h)
            path.addRoundRect(rect, radius, radius, Path.Direction.CW)
            canvas.clipPath(path)
            val fill = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = colorBg }
            canvas.drawRect(0f, 0f, w, h, fill)
            // 1dp 描边：在深色上与桌面壁纸的边界更清楚（范围文档未定，取壳内卡片同值）。
            val stroke = Paint(Paint.ANTI_ALIAS_FLAG).apply {
                color = colorBorder
                style = Paint.Style.STROKE
                strokeWidth = dp(1f)
            }
            rect.set(dp(0.5f), dp(0.5f), w - dp(0.5f), h - dp(0.5f))
            canvas.drawRoundRect(rect, radius, radius, stroke)
        }

        /* ------------------------------------------------------ 迷你月历 2×2 */

        fun miniMonth(snapshot: WidgetSnapshot) {
            val pad = dp(7f)
            val now = System.currentTimeMillis()
            val monthStart = CalKit.monthStart(now)
            val titlePaint = paint(12f, colorText, mediumWeight = true)
            val labelPaint = paint(10f, colorText3)
            val dayPaint = paint(10f, colorText)
            val mutedPaint = paint(10f, colorText3)
            val todayPaint = paint(10f, colorOnAccent)

            drawText(CalKit.monthTitle(now), pad, pad + sp(12f), w - pad * 2, titlePaint)

            val weekLabels = arrayOf("一", "二", "三", "四", "五", "六", "日")
            val weekBaseline = pad + sp(12f) + sp(10f)
            val rowsTop = weekBaseline + dp(3f)
            val gridBottom = h - pad
            val cellW = (w - pad * 2) / 7f
            val cellH = (gridBottom - rowsTop) / 6f
            for (col in 0 until 7) {
                drawCentered(
                    weekLabels[col],
                    pad + cellW * col + cellW / 2f,
                    weekBaseline,
                    labelPaint,
                    cellW,
                )
            }
            val gridStart = CalKit.monthGridStart(monthStart)
            for (row in 0 until 6) {
                for (col in 0 until 7) {
                    val dayMillis = CalKit.addDays(gridStart, row * 7 + col)
                    val day = CalKit.dayOfMonth(dayMillis)
                    val inMonth = CalKit.monthStart(dayMillis) == monthStart
                    val left = pad + cellW * col
                    val top = rowsTop + cellH * row
                    val cx = left + cellW / 2f
                    val cy = top + cellH / 2f
                    val isToday = inMonth && CalKit.isSameDay(dayMillis, now)
                    if (isToday) {
                        val radius = minOf(cellW, cellH) / 2f - dp(0.5f)
                        canvas.drawCircle(cx, cy, radius, solid(colorAccent))
                        drawCentered("$day", cx, cy + sp(3.6f), todayPaint, cellW)
                    } else {
                        drawCentered(
                            "$day",
                            cx,
                            cy + sp(3.6f),
                            if (inMonth) dayPaint else mutedPaint,
                            cellW,
                        )
                    }
                    // 2×2 被压到 provider 下限 110dp 时，每格只有约 11.8dp 高：
                    // 10sp 日号的字底已经贴到格底，再画 2dp 圆点会和数字叠在一起。
                    // 这种情况省略圆点（日号仍然完整）；正常 2×2（≥150dp 高）圆点照画。
                    val roomForDot = cellH >= dp(15f)
                    if (inMonth && roomForDot) {
                        val events = snapshot.eventsOn(dayMillis, CalKit.dayEnd(dayMillis))
                        if (events.isNotEmpty()) {
                            val dot = Paint(Paint.ANTI_ALIAS_FLAG).apply {
                                color = events.first().color ?: colorAccent
                            }
                            canvas.drawCircle(cx, top + cellH - dp(1.6f), dp(1.4f), dot)
                        }
                    }
                }
            }
        }

        /* ------------------------------------------------------ 今日日程 2×2 */

        fun dayAgenda(snapshot: WidgetSnapshot) {
            val pad = dp(10f)
            val now = System.currentTimeMillis()
            val dayStart = CalKit.dayStart(now)
            val dayEnd = CalKit.dayEnd(now)
            val headerPaint = paint(12f, colorText, mediumWeight = true)
            val timePaint = paint(10f, colorText3)
            val rowPaint = paint(10f, colorText)
            val header = context.getString(
                R.string.widget_today_header,
                CalKit.dayMonth(now),
            )
            drawText(header, pad, pad + sp(12f), w - pad * 2, headerPaint)

            val listTop = pad + sp(18f) + dp(2f)
            val footerSpace = dp(12f)
            val listBottom = h - pad - footerSpace
            val events = snapshot.eventsOn(dayStart, dayEnd)
            if (events.isEmpty()) {
                drawCentered(
                    context.getString(R.string.widget_today_none),
                    w / 2f,
                    (listTop + listBottom) / 2f,
                    paint(10f, colorText3),
                    w - pad * 2,
                )
                return
            }
            val maxRows = 3
            val shown = minOf(events.size, maxRows)
            val rowH = minOf(dp(22f), (listBottom - listTop) / maxRows)
            for (index in 0 until shown) {
                val event = events[index]
                val baseline = listTop + rowH * index + rowH / 2f + sp(3.6f)
                val time = if (event.allDay) context.getString(R.string.widget_all_day)
                else CalKit.hhmm(event.start)
                drawText(time, pad, baseline, dp(34f), timePaint)
                drawEllipsized(
                    event.summary.ifBlank { "—" },
                    pad + dp(36f),
                    baseline,
                    w - pad * 2 - dp(36f),
                    rowPaint,
                )
            }
            if (events.size > maxRows) {
                val more = context.getString(R.string.widget_more_items, events.size - maxRows)
                drawTextRight(more, w - pad, h - pad - dp(1f), paint(10f, colorText3))
            }
        }

        /* ------------------------------------------------------ 月视图 4×4 */

        fun month(snapshot: WidgetSnapshot) {
            val pad = dp(9f)
            val now = System.currentTimeMillis()
            val monthStart = CalKit.monthStart(now)
            val titlePaint = paint(12f, colorText, mediumWeight = true)
            val labelPaint = paint(10f, colorText3)
            val dayPaint = paint(10f, colorText)
            val mutedPaint = paint(10f, colorText3)

            drawText(CalKit.monthTitle(now), pad, pad + sp(12f), w - pad * 2, titlePaint)
            val weekLabels = arrayOf("一", "二", "三", "四", "五", "六", "日")
            val weekTop = pad + sp(18f)
            val gridTop = weekTop + sp(10f)
            val gridBottom = h - pad
            val cellW = (w - pad * 2) / 7f
            val cellH = (gridBottom - gridTop) / 6f
            for (col in 0 until 7) {
                drawCentered(
                    weekLabels[col],
                    pad + cellW * col + cellW / 2f,
                    weekTop + sp(10f),
                    labelPaint,
                    cellW,
                )
            }
            val gridStart = CalKit.monthGridStart(monthStart)
            for (row in 0 until 6) {
                for (col in 0 until 7) {
                    val left = pad + cellW * col
                    val top = gridTop + cellH * row
                    val dayMillis = CalKit.addDays(gridStart, row * 7 + col)
                    val inMonth = CalKit.monthStart(dayMillis) == monthStart
                    if (inMonth && col >= 5) {
                        canvas.drawRect(left, top, left + cellW, top + cellH, solid(colorWeekend))
                    }
                    val isToday = inMonth && CalKit.isSameDay(dayMillis, now)
                    val day = CalKit.dayOfMonth(dayMillis)
                    val baseline = top + sp(10f) + dp(1f)
                    if (isToday) {
                        canvas.drawCircle(
                            left + cellW / 2f,
                            baseline - sp(3.4f),
                            sp(7.6f),
                            solid(colorAccent),
                        )
                        drawCentered(
                            "$day",
                            left + cellW / 2f,
                            baseline,
                            paint(10f, colorOnAccent),
                            cellW,
                        )
                    } else {
                        drawCentered(
                            "$day",
                            left + cellW / 2f,
                            baseline,
                            if (inMonth) dayPaint else mutedPaint,
                            cellW,
                        )
                    }
                    if (!inMonth) continue
                    val events = snapshot.eventsOn(dayMillis, CalKit.dayEnd(dayMillis))
                    var barTop = baseline + dp(2f)
                    val barWidth = cellW - dp(4f)
                    for (index in 0 until minOf(events.size, 2)) {
                        val bar = Paint(Paint.ANTI_ALIAS_FLAG).apply {
                            color = events[index].color ?: colorAccent
                            alpha = 190
                        }
                        rect.set(left + dp(2f), barTop, left + dp(2f) + barWidth, barTop + dp(3f))
                        canvas.drawRoundRect(rect, dp(1.5f), dp(1.5f), bar)
                        barTop += dp(4.5f)
                    }
                    if (events.size > 2) {
                        drawTextRight(
                            "+" + (events.size - 2),
                            left + cellW - dp(1.5f),
                            top + cellH - dp(2f),
                            paint(10f, colorText3),
                        )
                    }
                }
            }
        }

        /* ------------------------------------------------------ 四日视图 4×4 */

        fun fourDay(snapshot: WidgetSnapshot) {
            val pad = dp(8f)
            val now = System.currentTimeMillis()
            val todayStart = CalKit.dayStart(now)
            val headerPaint = paint(10f, colorText, mediumWeight = true)
            val headerMuted = paint(10f, colorText3)
            val dayPaint = paint(10f, colorText3)
            val columnW = (w - pad * 2) / 4f
            val headerBaseline = pad + sp(10f)
            val bodyTop = pad + sp(14f) + dp(2f)
            val footerSpace = if (WidgetPrefs.lastError(context) != null) dp(14f) else dp(2f)
            val bodyBottom = h - pad - footerSpace
            val bodyH = bodyBottom - bodyTop
            if (bodyH <= 0f) return

            for (col in 0 until 4) {
                val dayMillis = CalKit.addDays(todayStart, col)
                val isToday = col == 0
                val left = pad + columnW * col
                if (isToday) {
                    rect.set(left, pad, left + columnW, bodyBottom)
                    canvas.drawRect(rect, solid(colorWeekend))
                }
                val label = CalKit.weekdayShort(dayMillis) + " " + CalKit.dayOfMonth(dayMillis)
                drawCentered(
                    label,
                    left + columnW / 2f,
                    headerBaseline,
                    if (isToday) paint(10f, colorAccent, mediumWeight = true) else headerMuted,
                    columnW - dp(2f),
                )
                if (col > 0) {
                    val line = Paint(Paint.ANTI_ALIAS_FLAG).apply {
                        color = colorBorder
                        strokeWidth = dp(0.6f)
                    }
                    canvas.drawLine(left, bodyTop, left, bodyBottom, line)
                }
            }

            // 每 6 小时一条浅线，给时间块一个参照。
            val gridLine = Paint(Paint.ANTI_ALIAS_FLAG).apply {
                color = colorBorder
                strokeWidth = dp(0.5f)
                alpha = 110
            }
            for (hour in intArrayOf(6, 12, 18)) {
                val y = bodyTop + bodyH * (hour / 24f)
                canvas.drawLine(pad, y, w - pad, y, gridLine)
            }

            for (col in 0 until 4) {
                val dayStart = CalKit.addDays(todayStart, col)
                val dayEnd = CalKit.dayEnd(dayStart)
                val left = pad + columnW * col
                val events = snapshot.eventsOn(dayStart, dayEnd)
                var allDayOffset = dp(1f)
                for (event in events) {
                    if (event.allDay) {
                        val bar = Paint(Paint.ANTI_ALIAS_FLAG).apply {
                            color = event.color ?: colorAccent
                            alpha = 200
                        }
                        rect.set(
                            left + dp(1f),
                            bodyTop + allDayOffset,
                            left + columnW - dp(1f),
                            bodyTop + allDayOffset + dp(3f),
                        )
                        canvas.drawRoundRect(rect, dp(1.5f), dp(1.5f), bar)
                        allDayOffset += dp(4.5f)
                        continue
                    }
                    val start = event.start.coerceIn(dayStart, dayEnd)
                    val end = event.end.coerceIn(dayStart, dayEnd)
                    val y0 = bodyTop + bodyH * ((start - dayStart).toFloat() / (dayEnd - dayStart))
                    val y1 = bodyTop + bodyH * ((end - dayStart).toFloat() / (dayEnd - dayStart))
                    val blockH = (y1 - y0).coerceAtLeast(dp(7f))
                    val eventColor = event.color ?: colorAccent
                    val fill = Paint(Paint.ANTI_ALIAS_FLAG).apply {
                        color = eventColor
                        alpha = 60
                    }
                    rect.set(left + dp(1.5f), y0, left + columnW - dp(1.5f), y0 + blockH)
                    canvas.drawRoundRect(rect, dp(2f), dp(2f), fill)
                    val edge = Paint(Paint.ANTI_ALIAS_FLAG).apply {
                        color = eventColor
                        strokeWidth = dp(2f)
                    }
                    canvas.drawLine(left + dp(2f), y0 + dp(1f), left + dp(2f), y0 + blockH - dp(1f), edge)
                    if (blockH >= dp(13f)) {
                        drawEllipsized(
                            event.summary.ifBlank { "—" },
                            left + dp(4f),
                            y0 + sp(9f),
                            columnW - dp(6f),
                            dayPaint,
                        )
                    }
                }
            }

            // 当前时间横线：今天在四天范围内时画在今天的列。
            if (CalKit.isSameDay(now, todayStart)) {
                val y = bodyTop + bodyH * ((now - todayStart).toFloat() / (dayEnd(todayStart) - todayStart))
                if (y in bodyTop..bodyBottom) {
                    val line = Paint(Paint.ANTI_ALIAS_FLAG).apply {
                        color = colorAccent
                        strokeWidth = dp(1.2f)
                    }
                    canvas.drawLine(pad, y, w - pad, y, line)
                    canvas.drawCircle(pad + dp(1.5f), y, dp(2f), solid(colorAccent))
                }
            }
        }

        /* ------------------------------------------------------ 日程列表 4×4 */

        fun agendaList(snapshot: WidgetSnapshot) {
            val pad = dp(10f)
            val now = System.currentTimeMillis()
            val todayStart = CalKit.dayStart(now)
            val titlePaint = paint(12f, colorText, mediumWeight = true)
            val dayPaint = paint(10f, colorText2, mediumWeight = true)
            val rowPaint = paint(10f, colorText)
            val metaPaint = paint(10f, colorText3)
            drawText(
                context.getString(R.string.widget_future_week),
                pad,
                pad + sp(12f),
                w - pad * 2,
                titlePaint,
            )
            val contentTop = pad + sp(18f) + dp(2f)
            val contentBottom = h - pad
            var baseline = contentTop + sp(10f)
            var drawn = 0
            var any = false
            for (dayIndex in 0 until 7) {
                val dayStart = CalKit.addDays(todayStart, dayIndex)
                val events = snapshot.eventsOn(dayStart, CalKit.dayEnd(dayStart))
                if (events.isEmpty()) continue
                if (baseline + sp(12f) > contentBottom) break
                any = true
                val dateLabel = CalKit.dayMonth(dayStart) + " " + CalKit.weekdayShort(dayStart)
                drawText(dateLabel, pad, baseline, w - pad * 2, dayPaint)
                baseline += sp(13f)
                for (event in events) {
                    if (drawn >= 12 || baseline + sp(11f) > contentBottom) break
                    val time = if (event.allDay) context.getString(R.string.widget_all_day)
                    else CalKit.hhmm(event.start)
                    var title = time + "  " + event.summary.ifBlank { "—" }
                    if (!event.location.isNullOrBlank()) title += " · " + event.location
                    drawEllipsized(title, pad, baseline, w - pad * 2, rowPaint)
                    drawn += 1
                    baseline += sp(12f)
                }
                baseline += dp(3f)
            }
            if (!any) {
                drawCentered(
                    context.getString(R.string.widget_week_none),
                    w / 2f,
                    (contentTop + contentBottom) / 2f,
                    metaPaint,
                    w - pad * 2,
                )
            }
        }

        /* ------------------------------------------------------ 公共部件 */

        /** 没有令牌 / 没有缓存：告诉用户去哪儿拿令牌，点击卡片直接进关于页。 */
        fun placeholder() {
            val centerY = h * 0.38f
            val gearColor = colorText3
            val radius = dp(9f)
            canvas.save()
            canvas.translate(w / 2f, centerY)
            for (index in 0 until 8) {
                canvas.save()
                canvas.rotate(index * 45f)
                rect.set(-dp(1.5f), -radius - dp(4f), dp(1.5f), -radius + dp(1f))
                canvas.drawRoundRect(rect, dp(1f), dp(1f), solid(gearColor))
                canvas.restore()
            }
            val ring = Paint(Paint.ANTI_ALIAS_FLAG).apply {
                color = gearColor
                style = Paint.Style.STROKE
                strokeWidth = dp(2f)
            }
            canvas.drawCircle(0f, 0f, radius, ring)
            canvas.drawCircle(0f, 0f, dp(3f), ring)
            canvas.restore()

            val textPaint = paint(10f, colorText2)
            val line1 = context.getString(R.string.widget_no_token)
            val line2 = context.getString(R.string.widget_no_token_hint)
            drawCentered(line1, w / 2f, centerY + dp(22f) + sp(10f), textPaint, w - dp(16f))
            drawCentered(line2, w / 2f, centerY + dp(22f) + sp(22f), paint(10f, colorText3), w - dp(16f))
        }

        /** 失败但还有旧缓存：右下角一行「上次更新 HH:mm」。 */
        fun staleFooter() {
            if (WidgetPrefs.lastError(context) == null) return
            val at = WidgetPrefs.lastUpdated(context)
            if (at <= 0L) return
            val text = context.getString(R.string.widget_updated, CalKit.hhmm(at))
            drawTextRight(text, w - dp(8f), h - dp(4f), paint(10f, colorText3))
        }

        /* ------------------------------------------------------ 绘制工具 */

        private fun solid(color: Int): Paint = Paint(Paint.ANTI_ALIAS_FLAG).apply { this.color = color }

        private fun drawText(text: String, x: Float, baseline: Float, maxWidth: Float, paint: TextPaint) {
            drawEllipsized(text, x, baseline, maxWidth, paint)
        }

        private fun drawEllipsized(
            text: String,
            x: Float,
            baseline: Float,
            maxWidth: Float,
            paint: TextPaint,
        ) {
            if (maxWidth <= 0f) return
            val fitted = TextUtils.ellipsize(text, paint, maxWidth, TextUtils.TruncateAt.END)
            canvas.drawText(fitted.toString(), x, baseline, paint)
        }

        private fun drawCentered(
            text: String,
            centerX: Float,
            baseline: Float,
            paint: TextPaint,
            maxWidth: Float,
        ) {
            val fitted = TextUtils.ellipsize(text, paint, maxWidth, TextUtils.TruncateAt.END)
            val width = paint.measureText(fitted.toString())
            canvas.drawText(fitted.toString(), centerX - width / 2f, baseline, paint)
        }

        private fun drawTextRight(text: String, right: Float, baseline: Float, paint: TextPaint) {
            val width = paint.measureText(text)
            canvas.drawText(text, right - width, baseline, paint)
        }

        private fun dayEnd(dayStart: Long): Long = Calendar.getInstance().apply {
            timeInMillis = dayStart
            add(Calendar.DAY_OF_MONTH, 1)
        }.timeInMillis
    }
}
