package com.paulcai1593.fncal.app

import android.content.Context
import android.content.res.Configuration
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
import kotlin.math.round

/** 0.3.3 的五款桌面卡片。每款只决定画法，数据都来自同一份摘要缓存。 */
enum class WidgetKind {
    MINI_MONTH,
    DAY_AGENDA,
    MONTH,
    FOUR_DAY,
    AGENDA_LIST,
}

/**
 * 0.3.3 的尺寸档位，按卡片**短边 dp** 判定（AppWidgetManager 给的是像素，除以 density 得 dp）：
 *   - SMALL  ≤ 140dp（2×2 及其下限 110dp）
 *   - MEDIUM 141–220dp（3×3 一档）
 *   - LARGE  > 220dp（4×4 及以上）
 *
 * 档位只决定内距、字号、行距与可显示条数；几何仍然全部从实际宽高算，
 * 因此同一个档位在横向拉伸时列宽会跟着变，不会出现「内容缩在角落」。
 */
enum class SizeTier {
    SMALL,
    MEDIUM,
    LARGE,
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

    /**
     * 0.3.4 §10.6：深色主题下事件框填充改用 alpha 20。
     *
     * 26/255 叠在深色 surface #16181F 上时，纯白事件色会把底色提到 #3A3C42，
     * text_3 #8A91A2 在其上只有 4.18:1（低于 4.5）；20/255 时 4.54:1。
     * 浅色主题 26/255 最差 4.57:1（纯黑事件色），保持不动。
     */
    private val darkTheme = (
        context.resources.configuration.uiMode and
            Configuration.UI_MODE_NIGHT_MASK
        ) == Configuration.UI_MODE_NIGHT_YES

    private val medium = Typeface.create("sans-serif-medium", Typeface.NORMAL)

    fun render(widthPx: Int, heightPx: Int): Bitmap {
        val width = widthPx.coerceAtLeast(1)
        val height = heightPx.coerceAtLeast(1)
        val bitmap = Bitmap.createBitmap(width, height, Bitmap.Config.ARGB_8888)
        val sketch = Sketch(Canvas(bitmap), width.toFloat(), height.toFloat(), tierOf(width, height))
        sketch.background()

        val snapshot = WidgetSnapshot.parse(
            WidgetPrefs.cache(context),
            WidgetPrefs.weekStartsOn(context),
        )
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

    /** 短边 dp 决定档位。三个阈值集中在这里，静态检查也查这三个常量。 */
    private fun tierOf(widthPx: Int, heightPx: Int): SizeTier {
        val shortDp = minOf(widthPx, heightPx) / density
        return when {
            shortDp <= TIER_SMALL_MAX_DP -> SizeTier.SMALL
            shortDp <= TIER_MEDIUM_MAX_DP -> SizeTier.MEDIUM
            else -> SizeTier.LARGE
        }
    }

    private fun sp(value: Float): Float = value * density

    private fun dp(value: Float): Float = value * density

    /** 行高与位置吸附到 1dp 整数，避免出现半像素行（0.3.4 §10.6）。 */
    private fun snapDp(value: Float): Float = dp(round(value / dp(1f)))

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
        private val tier: SizeTier,
    ) {

        private val path = Path()
        private val rect = RectF()

        private val isSmall: Boolean get() = tier == SizeTier.SMALL
        private val isLarge: Boolean get() = tier == SizeTier.LARGE

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

        /**
         * 0.3.3 §A：日期下的圆点对齐网页左侧栏迷你月历。每个有事件的日子都画点，
         * 0.3.0 的「格子太矮就整体省略」条件已取消；点直径随卡片高度在 2.0–3.0dp 之间取。
         */
        fun miniMonth(snapshot: WidgetSnapshot) {
            val pad = if (isSmall) dp(5f) else if (isLarge) dp(9f) else dp(7f)
            val now = System.currentTimeMillis()
            val monthStart = CalKit.monthStart(now)
            val titlePaint = if (isLarge) paint(13f, colorText, mediumWeight = true)
            else paint(12f, colorText, mediumWeight = true)
            val labelPaint = paint(10f, colorText3)
            val dayPaint = if (isLarge) paint(11f, colorText) else paint(10f, colorText)
            val mutedPaint = if (isLarge) paint(11f, colorText3) else paint(10f, colorText3)
            val todayPaint = if (isLarge) paint(11f, colorOnAccent) else paint(10f, colorOnAccent)

            val titleSp = if (isLarge) 13f else 12f
            drawText(CalKit.monthTitle(now), pad, pad + sp(titleSp), w - pad * 2, titlePaint)

            // 圆点直径：卡片高 110dp → 2.0dp；≥150dp → 3.0dp；中间线性，取整到 0.1dp。
            val heightDp = h / density
            val dotDp = roundToOneDecimal((2f + (heightDp - 110f) * 0.025f).coerceIn(2f, 3f))
            val dotD = dp(dotDp)

            val weekLabels = CalKit.weekLabels(snapshot.weekStartsOn)
            val weekBaseline = pad + sp(titleSp) + sp(10f)
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
            val gridStart = CalKit.monthGridStart(monthStart, snapshot.weekStartsOn)
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
                    val events = if (inMonth) {
                        snapshot.eventsOn(dayMillis, CalKit.dayEnd(dayMillis))
                    } else {
                        emptyList<WidgetEvent>()
                    }
                    val hasEvents = events.isNotEmpty()
                    // 0.3.4 §7.1：整卡统一预留圆点带，基线与「这天有没有事件」无关，
                    // 一排日号才对得齐；圆点仍画在格底。
                    val dotBand = dp(dotDp + 0.5f)
                    val baseline = cy + sp(3.6f) - dotBand
                    if (isToday && isSmall) {
                        // 0.3.3 总监修订：2×2 档格子只有约 12.5dp 高，给圆点让位后圆底半径
                        // 只剩约 2.75dp，包不住 10sp 日号。小档改为「强调色 + 加粗」日号，
                        // 不再画圆底；圆点照画，今天仍能一眼认出，也不与圆点相撞。
                        drawCentered(
                            "$day",
                            cx,
                            baseline,
                            paint(10f, colorAccent, mediumWeight = true),
                            cellW,
                        )
                    } else if (isToday) {
                        // 7.1：圆底与日号一起按 dotBand 上移；半径扣掉圆点带与 1dp 余量，
                        // 保证圆底与圆点不相切（三档实测留 2.75dp 间隙）。
                        val radius = (minOf(cellW, cellH - dotBand - dp(1f)) / 2f - dp(0.5f))
                            .coerceAtLeast(dp(2f))
                        canvas.drawCircle(cx, cy - dotBand, radius, solid(colorAccent))
                        drawCentered("$day", cx, baseline, todayPaint, cellW)
                    } else {
                        drawCentered(
                            "$day",
                            cx,
                            baseline,
                            if (inMonth) dayPaint else mutedPaint,
                            cellW,
                        )
                    }
                    if (hasEvents) {
                        // 点画在格子底部、水平居中；今天画在圆底之外的下方（保留 0.5dp 间隙）。
                        val dot = Paint(Paint.ANTI_ALIAS_FLAG).apply {
                            color = events.first().color ?: colorAccent
                        }
                        canvas.drawCircle(cx, top + cellH - dp(dotDp / 2f + 0.5f), dotD / 2f, dot)
                    }
                }
            }
        }

        /* ------------------------------------------------------ 今日日程 2×2 */

        fun dayAgenda(snapshot: WidgetSnapshot) {
            val pad = if (isSmall) dp(8f) else if (isLarge) dp(12f) else dp(10f)
            val now = System.currentTimeMillis()
            val dayStart = CalKit.dayStart(now)
            val dayEnd = CalKit.dayEnd(now)
            val headerPaint = if (isLarge) paint(13f, colorText, mediumWeight = true)
            else paint(12f, colorText, mediumWeight = true)
            // 0.3.4 §10.4：事件标题 10sp，时间与地点 9sp（整体下调）。
            val titlePaint = paint(10f, colorText, mediumWeight = true)
            val metaPaint = paint(9f, colorText3).apply { fontFeatureSettings = "tnum" }
            val metaPaintNoTnum = paint(9f, colorText3)
            val header = context.getString(
                R.string.widget_today_header,
                CalKit.dayMonth(now),
            )
            val titleSp = if (isLarge) 13f else 12f
            drawText(header, pad, pad + sp(titleSp), w - pad * 2, headerPaint)

            val listTop = pad + sp(titleSp + 6f) + dp(2f)
            // 底部 12dp 留给「还有 N 条」，避免它压住最后一条框。
            val footerSpace = dp(12f)
            val listBottom = h - pad - footerSpace
            val listH = listBottom - listTop
            if (listH <= 0f) return
            val events = snapshot.eventsOn(dayStart, dayEnd)
            if (events.isEmpty()) {
                drawCentered(
                    context.getString(R.string.widget_today_none),
                    w / 2f,
                    (listTop + listBottom) / 2f,
                    metaPaintNoTnum,
                    w - pad * 2,
                )
                return
            }
            // 0.3.4 §10.3：条数按可用高度分，行高吸附 1dp；行高够才带地点。
            // 单行框至少 16dp；带地点框至少 26dp，加上 2dp 行距，行高门槛取 28dp。
            val rowsLimit = if (isSmall) 3 else if (isLarge) 8 else 6
            var rowsCap = (listH / dp(16f)).toInt().coerceIn(1, rowsLimit)
            val hasLocation = events.any { !it.location.isNullOrBlank() }
            var rowH = snapDp(listH / rowsCap)
            // 有地点时宁可少一条，也要让行高撑到能放下第二行（优先保证地点可见）。
            while (hasLocation && rowH < dp(28f) && rowsCap > 1) {
                rowsCap -= 1
                rowH = snapDp(listH / rowsCap)
            }
            val withLocation = hasLocation && rowH >= dp(28f)
            val shown = minOf(events.size, rowsCap)
            val timeCol = if (isSmall) dp(24f) else if (isLarge) dp(34f) else dp(30f)
            for (index in 0 until shown) {
                val top = listTop + rowH * index
                drawEventFrame(
                    events[index],
                    pad,
                    top,
                    w - pad,
                    top + rowH - dp(2f),
                    timeCol,
                    titlePaint,
                    metaPaint,
                    withLocation,
                )
            }
            if (events.size > shown) {
                val more = context.getString(R.string.widget_more_items, events.size - shown)
                drawTextRight(more, w - pad, h - pad - dp(2f), metaPaintNoTnum)
            }
        }

        /* ------------------------------------------------------ 月视图 4×4 */

        fun month(snapshot: WidgetSnapshot) {
            val pad = if (isSmall) dp(7f) else if (isLarge) dp(11f) else dp(9f)
            val now = System.currentTimeMillis()
            val monthStart = CalKit.monthStart(now)
            val titleSp = if (isLarge) 13f else 12f
            val titlePaint = if (isLarge) paint(13f, colorText, mediumWeight = true)
            else paint(12f, colorText, mediumWeight = true)
            val labelPaint = paint(10f, colorText3)
            val dayPaint = if (isLarge) paint(11f, colorText) else paint(10f, colorText)
            val mutedPaint = if (isLarge) paint(11f, colorText3) else paint(10f, colorText3)

            drawText(CalKit.monthTitle(now), pad, pad + sp(titleSp), w - pad * 2, titlePaint)
            val weekLabels = CalKit.weekLabels(snapshot.weekStartsOn)
            val weekTop = pad + sp(titleSp + 6f)
            val gridTop = weekTop + sp(10f)
            val gridBottom = h - pad
            val cellW = (w - pad * 2) / 7f
            val cellH = (gridBottom - gridTop) / 6f
            // 0.3.3 §C：单格 ≥28dp 时进入「一行日程名称」模式；否则保持色条模式，两者互斥。
            val nameMode = cellH >= dp(MONTH_NAME_MIN_CELL_DP)
            for (col in 0 until 7) {
                drawCentered(
                    weekLabels[col],
                    pad + cellW * col + cellW / 2f,
                    weekTop + sp(10f),
                    labelPaint,
                    cellW,
                )
            }
            val gridStart = CalKit.monthGridStart(monthStart, snapshot.weekStartsOn)
            for (row in 0 until 6) {
                for (col in 0 until 7) {
                    val left = pad + cellW * col
                    val top = gridTop + cellH * row
                    val dayMillis = CalKit.addDays(gridStart, row * 7 + col)
                    val inMonth = CalKit.monthStart(dayMillis) == monthStart
                    // 0.3.4 §8：周末底色跟「每周开始日」走，不能再按列号写死。
                    if (inMonth && CalKit.weekdayIndex(dayMillis, snapshot.weekStartsOn) >= 5) {
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
                            if (isLarge) paint(11f, colorOnAccent) else paint(10f, colorOnAccent),
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
                    if (nameMode) {
                        // 名称模式：日号下一行 = 当天第一条事件的名称（10sp、单行省略），
                        // 左侧 4dp 色点（0.3.4 §7.2：2dp 太小，看不清）；第二条起不再画
                        // 名称，更多显示 +N。
                        if (events.isNotEmpty()) {
                            val first = events.first()
                            val nameBaseline = baseline + dp(10.5f)
                            canvas.drawCircle(
                                left + dp(3.5f),
                                nameBaseline - sp(3.3f),
                                dp(2f),
                                solid(first.color ?: colorAccent),
                            )
                            val namePaint = paint(10f, colorText)
                            val nameWidth = cellW - dp(7f)
                            canvas.drawText(
                                fitLabel(first.summary.ifBlank { "—" }, namePaint, nameWidth),
                                left + dp(6.5f),
                                nameBaseline,
                                namePaint,
                            )
                            if (events.size > 1) {
                                drawTextRight(
                                    "+" + (events.size - 1),
                                    left + cellW - dp(1.5f),
                                    top + cellH - dp(2f),
                                    paint(10f, colorText3),
                                )
                            }
                        }
                    } else {
                        var barTop = baseline + dp(2f)
                        val barWidth = cellW - dp(4f)
                        for (index in 0 until minOf(events.size, 2)) {
                            val bar = Paint(Paint.ANTI_ALIAS_FLAG).apply {
                                color = events[index].color ?: colorAccent
                                alpha = 190
                            }
                            rect.set(
                                left + dp(2f),
                                barTop,
                                left + dp(2f) + barWidth,
                                barTop + dp(3f),
                            )
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
        }

        /* ------------------------------------------------------ 四日视图 4×4 */

        fun fourDay(snapshot: WidgetSnapshot) {
            val pad = if (isSmall) dp(6f) else if (isLarge) dp(10f) else dp(8f)
            val now = System.currentTimeMillis()
            val todayStart = CalKit.dayStart(now)
            val headerSize = if (isLarge) 11f else 10f
            val headerPaint = if (isLarge) paint(11f, colorText, mediumWeight = true)
            else paint(10f, colorText, mediumWeight = true)
            val headerMuted = if (isLarge) paint(11f, colorText3) else paint(10f, colorText3)
            val dayPaint = if (isLarge) paint(10f, colorText) else paint(10f, colorText3)
            // 0.3.4 §9：左侧时间轴槽。2×2 太窄，保持 0.3.3 的版式（不画刻度）。
            val gutterW = if (isSmall) 0f else if (isLarge) dp(24f) else dp(20f)
            val columnW = (w - pad * 2 - gutterW) / 4f
            val headerBaseline = pad + sp(headerSize)
            val bodyTop = pad + sp(headerSize + 4f) + dp(2f)
            val footerSpace = if (WidgetPrefs.lastError(context) != null) dp(14f) else dp(2f)
            val bodyBottom = h - pad - footerSpace
            val bodyH = bodyBottom - bodyTop
            if (bodyH <= 0f) return

            for (col in 0 until 4) {
                val dayMillis = CalKit.addDays(todayStart, col)
                val isToday = col == 0
                val left = pad + gutterW + columnW * col
                if (isToday) {
                    rect.set(left, pad, left + columnW, bodyBottom)
                    canvas.drawRect(rect, solid(colorWeekend))
                }
                val label = CalKit.weekdayShort(dayMillis) + " " + CalKit.dayOfMonth(dayMillis)
                drawCentered(
                    label,
                    left + columnW / 2f,
                    headerBaseline,
                    if (isToday) {
                        if (isLarge) paint(11f, colorAccent, mediumWeight = true)
                        else paint(10f, colorAccent, mediumWeight = true)
                    } else {
                        headerMuted
                    },
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

            // 每 6 小时一条浅线 + 左侧刻度，给时间块一个参照。
            val gridLine = Paint(Paint.ANTI_ALIAS_FLAG).apply {
                color = colorBorder
                strokeWidth = dp(0.5f)
                alpha = 110
            }
            // 刻度文字是辅助信息：9sp，允许低于正文 10sp（范围文档 §9）。
            val tickPaint = paint(9f, colorText3)
            for (hour in intArrayOf(6, 12, 18)) {
                val y = bodyTop + bodyH * (hour / 24f)
                canvas.drawLine(pad + gutterW, y, w - pad, y, gridLine)
                if (gutterW > 0f) {
                    // 大档带 `:00`，中档只留小时数，避免 20dp 槽里挤成两行。
                    val label = if (isLarge) "$hour:00" else "$hour"
                    drawTextRight(label, pad + gutterW - dp(2f), y + sp(3.2f), tickPaint)
                }
            }

            val minBlock = if (isSmall) dp(11f) else if (isLarge) dp(15f) else dp(13f)
            val minBlockText = if (isSmall) dp(12f) else minBlock
            for (col in 0 until 4) {
                val dayStart = CalKit.addDays(todayStart, col)
                val dayEnd = CalKit.dayEnd(dayStart)
                val left = pad + gutterW + columnW * col
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
                    val blockH = (y1 - y0).coerceAtLeast(minBlock)
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
                    if (blockH >= minBlockText) {
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
                val y = bodyTop + bodyH * ((now - todayStart).toFloat() / (CalKit.dayEnd(todayStart) - todayStart))
                if (y in bodyTop..bodyBottom) {
                    val line = Paint(Paint.ANTI_ALIAS_FLAG).apply {
                        color = colorAccent
                        strokeWidth = dp(1.2f)
                    }
                    canvas.drawLine(pad + gutterW, y, w - pad, y, line)
                    canvas.drawCircle(pad + gutterW + dp(1.5f), y, dp(2f), solid(colorAccent))
                }
            }
        }

        /* ------------------------------------------------------ 日程列表 4×4 */

        fun agendaList(snapshot: WidgetSnapshot) {
            val pad = if (isSmall) dp(8f) else if (isLarge) dp(12f) else dp(10f)
            val now = System.currentTimeMillis()
            val todayStart = CalKit.dayStart(now)
            val titleSp = if (isLarge) 13f else 12f
            val titlePaint = if (isLarge) paint(13f, colorText, mediumWeight = true)
            else paint(12f, colorText, mediumWeight = true)
            // 0.3.4 §10.4：日期头 10sp，事件标题 10sp，时间与地点 9sp。
            val datePaint = paint(10f, colorText2, mediumWeight = true)
            val rowPaint = paint(10f, colorText, mediumWeight = true)
            val metaPaint = paint(9f, colorText3).apply { fontFeatureSettings = "tnum" }
            val metaPaintNoTnum = paint(9f, colorText3)
            drawText(
                context.getString(R.string.widget_future_week),
                pad,
                pad + sp(titleSp),
                w - pad * 2,
                titlePaint,
            )
            val contentTop = pad + sp(titleSp + 6f) + dp(2f)
            // 底部预留「还有 N 条」一行，避免它压住最后一个框。
            val contentBottom = h - pad - dp(11f)
            val timeCol = if (isLarge) dp(34f) else dp(30f)
            val days = Array(7) { index ->
                val dayStart = CalKit.addDays(todayStart, index)
                snapshot.eventsOn(dayStart, CalKit.dayEnd(dayStart))
            }
            val total = days.sumOf { it.size }
            if (total == 0) {
                drawCentered(
                    context.getString(R.string.widget_week_none),
                    w / 2f,
                    (contentTop + contentBottom) / 2f,
                    metaPaintNoTnum,
                    w - pad * 2,
                )
                return
            }
            var y = contentTop
            var drawn = 0
            var cut = false
            for (dayIndex in 0 until 7) {
                val events = days[dayIndex]
                if (events.isEmpty()) continue
                val headerBaseline = y + sp(10f)
                // 至少还要放得下日期头 + 一个单行框，否则整组不再画。
                if (headerBaseline + dp(3f) + dp(16f) > contentBottom) {
                    cut = true
                    break
                }
                val dayStart = CalKit.addDays(todayStart, dayIndex)
                val dateLabel = CalKit.dayMonth(dayStart) + " " + CalKit.weekdayShort(dayStart)
                drawText(dateLabel, pad, headerBaseline, w - pad * 2, datePaint)
                var frameTop = headerBaseline + dp(3f)
                for (event in events) {
                    val frameH = if (!event.location.isNullOrBlank()) dp(26f) else dp(16f)
                    if (frameTop + frameH > contentBottom) {
                        cut = true
                        break
                    }
                    drawEventFrame(
                        event,
                        pad,
                        frameTop,
                        w - pad,
                        frameTop + frameH,
                        timeCol,
                        rowPaint,
                        metaPaint,
                        true,
                    )
                    drawn += 1
                    frameTop += frameH + dp(2f)
                }
                if (cut) break
                // 组间 8dp：从最后一框底算起（frameTop 已多加一个 2dp 行距）。
                y = frameTop - dp(2f) + dp(8f)
            }
            if (cut && total > drawn) {
                val more = context.getString(R.string.widget_more_items, total - drawn)
                drawTextRight(more, w - pad, h - pad - dp(2f), metaPaintNoTnum)
            }
        }

        /**
         * 0.3.4 §10.2 / §10.6：一条事件一个 6dp 圆角框（事件色 alpha 26，深色主题 20，无描边），
         * 框内 = 4dp 实心圆点 + 右对齐时间列 + 标题（10sp 550 字重）+ 地点第二行。
         * 所有水平位置都落在 1dp：左内距 6、圆点直径 4、圆点右缘距时间 4、
         * 时间列宽由调用方给（24/30/34），标题起点 = 时间列右缘 + 6。
         */
        private fun drawEventFrame(
            event: WidgetEvent,
            frameLeft: Float,
            frameTop: Float,
            frameRight: Float,
            frameBottom: Float,
            timeCol: Float,
            titlePaint: TextPaint,
            metaPaint: TextPaint,
            withLocation: Boolean,
        ) {
            if (frameBottom - frameTop < dp(1f)) return
            val eventColor = event.color ?: colorAccent
            val frameFill = Paint(Paint.ANTI_ALIAS_FLAG).apply {
                color = eventColor
                // 淡底 + 实点：框填充浅色 26/255（≈10%）、深色 20/255（对比度 4.54:1），圆点不透明。
                alpha = if (darkTheme) 20 else 26
            }
            rect.set(frameLeft, frameTop, frameRight, frameBottom)
            canvas.drawRoundRect(rect, dp(6f), dp(6f), frameFill)

            val padH = dp(6f)
            val dotR = dp(2f)
            val dotCx = frameLeft + padH + dotR
            val timeLeft = dotCx + dotR + dp(4f)
            val timeRight = timeLeft + timeCol
            val titleX = timeRight + dp(6f)
            val titleMax = frameRight - padH - titleX
            val fmTitle = titlePaint.fontMetrics
            // 上内距默认 3dp；框高不足（<30dp）时先减内距、不减字号（§10.6），
            // 保证两行文本在 26dp 框里不溢出。
            val padV = if (frameBottom - frameTop >= dp(30f)) dp(3f) else dp(1f)
            // 取标题基线；时间与标题共用这条基线。
            val baseline = frameTop + padV - fmTitle.ascent
            // 圆点与标题行视觉居中：圆心 = 基线 − 3.4sp。
            val dotCy = baseline - sp(3.4f)
            canvas.drawCircle(dotCx, dotCy, dotR, solid(eventColor))
            val time = if (event.allDay) context.getString(R.string.widget_all_day)
            else CalKit.hhmm(event.start)
            drawTextRight(time, timeRight, baseline, metaPaint)
            drawEllipsized(
                event.summary.ifBlank { "—" },
                titleX,
                baseline,
                titleMax,
                titlePaint,
            )
            val location = event.location
            if (withLocation && !location.isNullOrBlank()) {
                drawEllipsized(location, titleX, baseline + sp(11.5f), titleMax, metaPaint)
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

        /**
         * 0.3.4 §7.2（B）：月视图名称按**实际字体宽度**截断。
         *
         * 逐字量「前缀 + …」，取能放下的最长前缀：先试「2 字 + …」，不行再试
         * 「1 字 + …」，连一个字都放不下才只留「…」。不按字符数硬判，字号固定 10sp。
         */
        private fun fitLabel(text: String, paint: TextPaint, maxWidth: Float): String {
            if (maxWidth <= 0f) return ""
            if (paint.measureText(text) <= maxWidth) return text
            val ellipsis = "…"
            var count = text.length - 1
            while (count > 0) {
                val candidate = text.substring(0, count) + ellipsis
                if (paint.measureText(candidate) <= maxWidth) return candidate
                count -= 1
            }
            return if (paint.measureText(ellipsis) <= maxWidth) ellipsis else ""
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
    }

    companion object {
        /** 档位阈值：≤140dp 最小档，141–220dp 中档，>220dp 大档。 */
        const val TIER_SMALL_MAX_DP = 140f
        const val TIER_MEDIUM_MAX_DP = 220f

        /** 月视图单格达到这个高度才画一行日程名称（否则保持色条模式）。 */
        const val MONTH_NAME_MIN_CELL_DP = 28f
    }
}

/** 0.1dp 取整：圆点直径在 2.0–3.0dp 之间，避免 2.0373… 这类浮点尾数写进注释与记录。 */
private fun roundToOneDecimal(value: Float): Float = round(value * 10f) / 10f
