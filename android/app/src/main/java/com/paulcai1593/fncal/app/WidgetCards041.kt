package com.paulcai1593.fncal.app

import android.content.Context
import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Paint
import android.graphics.Path
import android.graphics.RectF
import android.graphics.Typeface
import android.text.TextPaint
import java.text.SimpleDateFormat
import java.util.Calendar
import java.util.Date
import java.util.Locale

/**
 * 0.4.1 的九款桌面卡片（设计定稿：`projects/FnCal/design/widget-design/设计结论.md`）。
 *
 * 分工：
 *   - `WidgetTokens`：颜色与颜色运算（含 `accentInk`、四档、徽章实底/淡底）；
 *   - `WidgetStats`：纯统计（日热度、分类前 5、一周节奏、时段曲线、徽章偏移）；
 *   - 本类：只画。所有尺寸按设计稿的 dp 数值，乘以 density 绘制。
 *
 * 主题色：卡片一律读网页设置 `accentColor`，先经 `accentInk` 压深再用；
 * 日历九色与分组十色不跟主题色。主题色只影响：今天、大月历今天格、
 * 热力图今天描边、一周节奏柱子与首列字、时段曲线与峰值顶点。
 */
class WidgetCards041(
    private val context: Context,
    private val kind: WidgetKind,
) {

    private val density = context.resources.displayMetrics.density
    private val medium = Typeface.create("sans-serif-medium", Typeface.NORMAL)

    private val ink: Int = WidgetTokens.accentInk(WidgetPrefs.accentColor(context))

    private val now: Long = System.currentTimeMillis()

    /** 卡片是否横向（4×2 / 2×2 之外的宽卡），用于统计四款选大小档。 */
    private fun wide(w: Float, h: Float): Boolean = w / h >= 1.55f

    private fun dp(value: Float): Float = value * density

    private fun tp(size: Float, color: Int, medium: Boolean = false): TextPaint =
        TextPaint(Paint.ANTI_ALIAS_FLAG).apply {
            textSize = dp(size)
            this.color = color
            if (medium) typeface = this@WidgetCards041.medium
        }

    private fun solid(color: Int): Paint = Paint(Paint.ANTI_ALIAS_FLAG).apply { this.color = color }

    private fun stroke(color: Int, widthDp: Float): Paint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        this.color = color
        style = Paint.Style.STROKE
        strokeWidth = dp(widthDp)
    }

    /* ------------------------------------------------------------ 入口 */

    fun draw(canvas: Canvas, widthPx: Int, heightPx: Int, snapshot: WidgetSnapshot?, signedIn: Boolean) {
        val w = widthPx.toFloat()
        val h = heightPx.toFloat()
        val sketch = Sketch(canvas, w, h)
        sketch.background()

        val revoked = WidgetPrefs.lastError(context) == "unauthorized"
        if (!signedIn || revoked || snapshot == null) {
            sketch.placeholder()
            return
        }
        when (kind) {
            WidgetKind.MINI_MONTH -> sketch.miniMonth(snapshot)
            WidgetKind.DAY_AGENDA -> sketch.dayAgenda(snapshot)
            WidgetKind.MONTH -> sketch.month(snapshot)
            WidgetKind.FOUR_DAY -> sketch.fourDay(snapshot)
            WidgetKind.AGENDA_LIST -> sketch.agendaList(snapshot)
            WidgetKind.MONTH_HEAT -> sketch.monthHeat(snapshot)
            WidgetKind.MONTH_CATEGORY -> sketch.monthCategory(snapshot)
            WidgetKind.WEEK_RHYTHM -> sketch.weekRhythm(snapshot)
            WidgetKind.HOURS -> sketch.hours(snapshot)
        }
        sketch.staleFooter(snapshot)
    }

    /* ------------------------------------------------------------ 内层 */

    private inner class Sketch(
        private val canvas: Canvas,
        private val w: Float,
        private val h: Float,
    ) {

        private val rect = RectF()
        private val path = Path()

        /** 白卡 + 18dp 圆角 + 1dp 描边（设计定稿）。 */
        fun background() {
            val radius = dp(18f)
            path.reset()
            rect.set(0f, 0f, w, h)
            path.addRoundRect(rect, radius, radius, Path.Direction.CW)
            canvas.clipPath(path)
            canvas.drawRect(0f, 0f, w, h, solid(WidgetTokens.CARD_BG))
            rect.set(dp(0.5f), dp(0.5f), w - dp(0.5f), h - dp(0.5f))
            canvas.drawRoundRect(rect, radius, radius, stroke(WidgetTokens.BORDER, 1f))
        }

        /* ---- 文本工具 ---- */

        /** 单行绘制；超出宽度就逐字退到省略号，绝不画半个字。 */
        private fun text(
            p: TextPaint,
            value: String,
            x: Float,
            baseline: Float,
            maxW: Float,
            align: Paint.Align = Paint.Align.LEFT,
        ): Float {
            if (value.isEmpty()) return 0f
            val room = maxW.coerceAtLeast(0f)
            var shown = value
            if (p.measureText(shown) > room) {
                val dots = "…"
                var cut = shown.length
                while (cut > 0 && p.measureText(shown.substring(0, cut) + dots) > room) {
                    cut -= 1
                }
                shown = if (cut <= 0) "" else shown.substring(0, cut) + dots
            }
            if (shown.isEmpty()) return 0f
            val old = p.textAlign
            p.textAlign = align
            val drawX = if (align == Paint.Align.RIGHT) x + room else x
            canvas.drawText(shown, drawX, baseline, p)
            p.textAlign = old
            return p.measureText(shown)
        }

        private fun textCenter(p: TextPaint, value: String, cx: Float, baseline: Float) {
            val old = p.textAlign
            p.textAlign = Paint.Align.CENTER
            canvas.drawText(value, cx, baseline, p)
            p.textAlign = old
        }

        private fun header(title: String, right: String?, pad: Float, titleSize: Float, rightSize: Float) {
            val titlePaint = tp(titleSize, WidgetTokens.TEXT, medium = true)
            val rightPaint = tp(rightSize, WidgetTokens.TEXT_3)
            val rightW = if (right.isNullOrBlank()) 0f else rightPaint.measureText(right) + dp(8f)
            text(titlePaint, title, pad, pad + titleSize, w - pad * 2f - rightW)
            if (!right.isNullOrBlank()) {
                text(rightPaint, right, w - pad - rightW, pad + rightSize, rightW, Paint.Align.RIGHT)
            }
        }

        private fun monthShort(millis: Long): String {
            val cal = Calendar.getInstance().apply { timeInMillis = millis }
            return (cal.get(Calendar.MONTH) + 1).toString() + " 月"
        }

        private fun yearOf(millis: Long): String =
            SimpleDateFormat("yyyy", Locale.US).format(Date(millis))

        private fun statEvents(snapshot: WidgetSnapshot): List<WidgetStats.StatEvent> =
            snapshot.events.map { event ->
                WidgetStats.StatEvent(
                    start = event.start,
                    end = event.end,
                    allDay = event.allDay,
                    calendarKey = event.calendarId ?: (event.color?.toString() ?: ""),
                    calendarName = snapshot.calendarName(event.calendarId).ifBlank { "" },
                    calendarColor = event.color ?: WidgetTokens.calendarFallbackColor(event.calendarId),
                    tagEmoji = event.tagEmoji,
                    tagGroupName = event.tagGroupName,
                    tagGroupIndex = event.tagGroupIndex,
                )
            }

        /** 当天的主 emoji（热度格与大月历共用）。 */
        private fun dayCellColor(cell: WidgetStats.DayCell): Int =
            if (!cell.filled) WidgetTokens.EMPTY_CELL else WidgetTokens.heatColor(cell.colorArgb, cell.count)

        /* ---------------------------------------------------- ① 小月历 2×2 */

        fun miniMonth(snapshot: WidgetSnapshot) {
            val pad = dp(9f)
            val monthStart = CalKit.monthStart(now)
            header(CalKit.monthTitle(now), yearOf(now), pad, 11.5f, 9f)
            val weekPaint = tp(7.2f, WidgetTokens.TEXT_3)
            val dayPaint = tp(8.6f, WidgetTokens.TEXT)
            val mutePaint = tp(8.6f, WidgetTokens.TEXT_3)
            val todayPaint = tp(8.6f, WidgetTokens.WHITE, medium = true)
            val labels = CalKit.weekLabels(snapshot.weekStartsOn)
            val cellW = (w - pad * 2f) / 7f
            val weekBaseline = pad + dp(11.5f) + dp(11f)
            for (col in 0 until 7) textCenter(weekPaint, labels[col], pad + cellW * col + cellW / 2f, weekBaseline)
            val gridTop = weekBaseline + dp(5f)
            val cellH = (h - pad - gridTop) / 6f
            val gridStart = CalKit.monthGridStart(monthStart, snapshot.weekStartsOn)
            for (row in 0 until 6) {
                for (col in 0 until 7) {
                    val day = CalKit.addDays(gridStart, row * 7 + col)
                    val inMonth = CalKit.monthStart(day) == monthStart
                    val cx = pad + cellW * col + cellW / 2f
                    val cy = gridTop + cellH * row + cellH / 2f
                    val isToday = inMonth && CalKit.isSameDay(day, now)
                    val baseline = cy + dp(3f)
                    if (isToday) {
                        rect.set(cx - dp(9.5f), cy - dp(7f), cx + dp(9.5f), cy + dp(7f))
                        canvas.drawRoundRect(rect, dp(4.5f), dp(4.5f), solid(ink))
                        textCenter(todayPaint, CalKit.dayOfMonth(day).toString(), cx, baseline)
                    } else {
                        textCenter(
                            if (inMonth) dayPaint else mutePaint,
                            CalKit.dayOfMonth(day).toString(),
                            cx,
                            baseline,
                        )
                    }
                    if (!inMonth) continue
                    val events = snapshot.eventsOn(CalKit.dayStart(day), CalKit.dayEnd(day))
                    if (events.isNotEmpty()) {
                        val dot = solid(events.first().color ?: ink)
                        canvas.drawCircle(cx, cy + dp(8.6f), dp(1.5f), dot)
                    }
                }
            }
        }

        /* -------------------------------------------------- ② 今日日程 2×2 */

        fun dayAgenda(snapshot: WidgetSnapshot) {
            val pad = dp(12f)
            val dayStart = CalKit.dayStart(now)
            val events = snapshot.eventsOn(dayStart, CalKit.dayEnd(now))
            header(
                context.getString(R.string.widget_today_header, CalKit.dayMonth(now)),
                if (events.isEmpty()) null else context.getString(R.string.widget_count_items, events.size),
                pad,
                12.5f,
                9f,
            )
            val timePaint = tp(8.6f, WidgetTokens.TEXT_2, medium = true).apply { fontFeatureSettings = "tnum" }
            val titlePaint = tp(9.6f, WidgetTokens.TEXT, medium = true)
            val placePaint = tp(7.8f, WidgetTokens.TEXT_3)
            val emojiPaint = tp(9.2f, WidgetTokens.TEXT)
            val morePaint = tp(7.8f, WidgetTokens.TEXT_3)
            val listTop = pad + dp(12.5f) + dp(9f)
            if (events.isEmpty()) {
                textCenter(morePaint, context.getString(R.string.widget_today_none), w / 2f, (listTop + h - pad) / 2f)
                return
            }
            val shown = events.take(3)
            var rowTop = listTop
            for (event in shown) {
                val color = event.color ?: ink
                canvas.drawRoundRect(
                    RectF(pad, rowTop + dp(3f), pad + dp(3f), rowTop + dp(29f)),
                    dp(1.5f), dp(1.5f), solid(color),
                )
                val left = pad + dp(9f)
                val timeText = if (event.allDay) context.getString(R.string.widget_all_day) else CalKit.hhmm(event.start)
                text(timePaint, timeText, left, rowTop + dp(11f), dp(60f))
                text(titlePaint, event.summary, left, rowTop + dp(22f), w - pad - left - dp(14f))
                val place = event.location
                if (!place.isNullOrBlank()) {
                    text(placePaint, place, left, rowTop + dp(31.5f), w - pad - left - dp(14f))
                }
                val emoji = tagEmojiOf(event)
                if (emoji.isNotEmpty()) {
                    val p = emojiPaint
                    var size = 9.2f
                    if (p.measureText(emoji) > dp(12f)) size = 8.4f
                    val paint = tp(size, WidgetTokens.TEXT)
                    text(paint, emoji, w - pad, rowTop + dp(16f), dp(14f), Paint.Align.RIGHT)
                }
                rowTop += dp(32f)
            }
            if (events.size > shown.size) {
                text(
                    morePaint,
                    context.getString(R.string.widget_more_rows, events.size - shown.size),
                    pad,
                    h - pad,
                    w - pad * 2f,
                )
            }
        }

        private fun tagEmojiOf(event: WidgetEvent): String {
            val explicit = event.tagEmoji?.trim().orEmpty()
            if (explicit.isNotEmpty()) return explicit
            val group = event.tagGroupName?.trim().orEmpty()
            val source = group.ifBlank { event.summary }
            return WidgetStats.firstChar(source)
        }

        /* ---------------------------------------------------- ③ 大月历 4×4 */

        fun month(snapshot: WidgetSnapshot) {
            val pad = dp(12f)
            val monthStart = CalKit.monthStart(now)
            val events = statEvents(snapshot)
            val days = CalKit.daysInMonth(monthStart)
            val cells = WidgetStats.monthCells(monthStart, days, events) { day, offset ->
                CalKit.addDays(day, offset)
            }
            val busy = cells.count { it.filled }
            header(
                CalKit.monthTitle(now),
                context.getString(R.string.widget_busy_days, busy),
                pad,
                14f,
                9f,
            )
            val weekPaint = tp(8.4f, WidgetTokens.TEXT_3)
            val labels = CalKit.weekLabels(snapshot.weekStartsOn)
            val cl = (w - pad * 2f) / 7f
            val gridTop = pad + dp(30f)
            for (col in 0 until 7) textCenter(weekPaint, labels[col], pad + cl * col + cl / 2f, gridTop - dp(8f))
            val rowH = (h - pad - gridTop) / 6f
            val lead = CalKit.weekdayIndex(monthStart, snapshot.weekStartsOn)
            val dayPaint = tp(11f, WidgetTokens.TEXT)
            val mutePaint = tp(11f, WidgetTokens.TEXT_3)
            val todayPaint = tp(11f, WidgetTokens.WHITE, medium = true)
            val dia = dp(WidgetTokens.BADGE_DIAMETER_DP)
            val emojiPaint = tp(WidgetStats.badgeEmojiSize(), WidgetTokens.TEXT)
            for (index in cells.indices) {
                val slot = lead + index
                val row = slot / 7
                val col = slot % 7
                val rowTop = gridTop + rowH * row
                val cx = pad + cl * col + cl / 2f
                val cell = cells[index]
                val isToday = CalKit.isSameDay(cell.dayStart, now)
                val day = CalKit.dayOfMonth(cell.dayStart)
                if (isToday) {
                    rect.set(cx - dp(11f), rowTop + dp(1f), cx + dp(11f), rowTop + dp(14.5f))
                    canvas.drawRoundRect(rect, dp(5f), dp(5f), solid(ink))
                    textCenter(todayPaint, day.toString(), cx, rowTop + dp(12f))
                } else {
                    val weekend = isWeekend(col, snapshot.weekStartsOn)
                    textCenter(if (weekend) mutePaint else dayPaint, day.toString(), cx, rowTop + dp(12f))
                }
                if (cell.badges.isEmpty()) continue
                val offsets = WidgetStats.badgeOffsets(cell.badges.size)
                for (i in cell.badges.indices) {
                    val badge = cell.badges[i]
                    val (dx, dy) = offsets[i]
                    val bx = cx + dp(dx)
                    val by = rowTop + dp(21f) + dp(dy)
                    canvas.drawCircle(bx, by, dia / 2f, solid(badge.fillColor))
                    val ring = badge.ringColor
                    if (ring != null) canvas.drawCircle(bx, by, dia / 2f, stroke(ring, 0.7f))
                    if (badge.emoji.isNotEmpty()) {
                        textCenter(emojiPaint, badge.emoji, bx, by + dp(WidgetStats.badgeEmojiSize() * 0.36f))
                    }
                }
            }
        }

        private fun isWeekend(col: Int, weekStartsOn: Int): Boolean =
            if (CalKit.normalizedWeekStart(weekStartsOn) == 1) col >= 5 else (col == 0 || col == 6)

        /* -------------------------------------------------- ④ 四日 4×2 / 4×4 */

        fun fourDay(snapshot: WidgetSnapshot) {
            if (wide(w, h)) fourDayCompact(snapshot) else fourDayLarge(snapshot)
        }

        private fun fourDayDays(): List<Long> {
            val today = CalKit.dayStart(now)
            return (0 until 4).map { CalKit.addDays(today, it) }
        }

        private fun fourDayCompact(snapshot: WidgetSnapshot) {
            val pad = dp(12f)
            val days = fourDayDays()
            val events = snapshot.events
            header(
                context.getString(
                    R.string.widget_four_day_range,
                    CalKit.dayMonth(days.first()),
                    CalKit.dayMonth(days.last()),
                ),
                context.getString(R.string.widget_days_items, 4, events.size),
                pad,
                12.5f,
                9f,
            )
            val colW = (w - pad * 2f) / 4f
            val divider = stroke(WidgetTokens.DIVIDER, 0.6f)
            val top = pad + dp(20f)
            val weekdayPaint = tp(7.8f, WidgetTokens.TEXT_3)
            val datePaint = tp(9.4f, WidgetTokens.TEXT, medium = true)
            val timePaint = tp(7.8f, WidgetTokens.TEXT_2, medium = true).apply { fontFeatureSettings = "tnum" }
            val titlePaint = tp(9.2f, WidgetTokens.TEXT)
            val morePaint = tp(7.2f, WidgetTokens.TEXT_3)
            for (col in 1 until 4) {
                val x = pad + colW * col
                canvas.drawLine(x, top + dp(6f), x, h - pad - dp(10f), divider)
            }
            days.forEachIndexed { index, day ->
                val left = pad + colW * index
                val cx = left + colW / 2f
                val dayStart = CalKit.dayStart(day)
                val dayEnd = CalKit.dayEnd(day)
                val isToday = CalKit.isSameDay(day, now)
                if (isToday) {
                    canvas.drawCircle(cx, top + dp(12f), dp(8.4f), solid(ink))
                    textCenter(tp(8.6f, WidgetTokens.WHITE, medium = true), CalKit.dayOfMonth(day).toString(), cx, top + dp(14.6f))
                } else {
                    textCenter(datePaint, CalKit.dayOfMonth(day).toString(), cx, top + dp(14f))
                }
                textCenter(weekdayPaint, CalKit.weekdayShort(day).removePrefix("周"), cx, top + dp(24f))
                val todays = snapshot.eventsOn(dayStart, dayEnd).take(3)
                var rowTop = top + dp(28f)
                for (event in todays) {
                    val color = event.color ?: ink
                    canvas.drawRoundRect(
                        RectF(left + dp(4f), rowTop + dp(1f), left + dp(7f), rowTop + dp(16f)),
                        dp(1.5f), dp(1.5f), solid(color),
                    )
                    val tx = left + dp(10f)
                    val timeText = if (event.allDay) context.getString(R.string.widget_all_day_short)
                    else CalKit.hhmm(event.start)
                    val timeW = text(timePaint, timeText, tx, rowTop + dp(8f), colW - dp(14f))
                    var title = event.summary
                    val emoji = tagEmojiOf(event)
                    val titleRoom = colW - dp(14f)
                    if (emoji.isNotEmpty() && titleRoom - timeW > dp(24f)) {
                        val emojiPaint = tp(8.4f, WidgetTokens.TEXT)
                        text(emojiPaint, emoji, tx, rowTop + dp(17.5f), dp(10f))
                        text(titlePaint, title, tx + dp(11f), rowTop + dp(17.5f), titleRoom - dp(11f))
                    } else {
                        text(titlePaint, title, tx, rowTop + dp(17.5f), titleRoom)
                    }
                    rowTop += dp(19f)
                }
                val all = snapshot.eventsOn(dayStart, dayEnd)
                if (all.size > todays.size) {
                    text(morePaint, context.getString(R.string.widget_more_rows, all.size - todays.size), left + dp(4f), h - pad, colW - dp(8f))
                }
            }
        }

        private fun fourDayLarge(snapshot: WidgetSnapshot) {
            val pad = dp(11f)
            val days = fourDayDays()
            header(
                context.getString(
                    R.string.widget_four_day_range,
                    CalKit.dayMonth(days.first()),
                    CalKit.dayMonth(days.last()),
                ),
                context.getString(R.string.widget_days_items, 4, snapshot.events.size),
                pad,
                12.5f,
                9f,
            )
            val colW = (w - pad * 2f) / 4f
            val top = pad + dp(20f)
            val blockBottom = h - pad
            val datePaint = tp(14f, WidgetTokens.TEXT, medium = true)
            val weekdayPaint = tp(8f, WidgetTokens.TEXT_3)
            val timePaint = tp(7.4f, WidgetTokens.TEXT_2, medium = true).apply { fontFeatureSettings = "tnum" }
            val titlePaint = tp(8.4f, WidgetTokens.TEXT, medium = true)
            val placePaint = tp(7.2f, WidgetTokens.TEXT_3)
            days.forEachIndexed { index, day ->
                val left = pad + colW * index
                val isToday = CalKit.isSameDay(day, now)
                rect.set(left + dp(1f), top, left + colW - dp(1f), blockBottom)
                canvas.drawRoundRect(
                    rect, dp(8f), dp(8f),
                    solid(if (isToday) WidgetTokens.SOFT_DAY else WidgetTokens.SOFT_DAY_2),
                )
                val cx = left + colW / 2f
                textCenter(datePaint, CalKit.dayOfMonth(day).toString(), cx, top + dp(19f))
                textCenter(weekdayPaint, CalKit.weekdayShort(day), cx, top + dp(29f))
                var cardTop = top + dp(34f)
                val todays = snapshot.eventsOn(CalKit.dayStart(day), CalKit.dayEnd(day))
                val shown = todays.take(((blockBottom - cardTop) / dp(39f)).toInt().coerceAtLeast(0))
                for (event in shown) {
                    val color = event.color ?: ink
                    rect.set(left + dp(4f), cardTop, left + colW - dp(4f), cardTop + dp(35f))
                    canvas.drawRoundRect(rect, dp(5f), dp(5f), solid(WidgetTokens.tintWhite(color, 0.86f)))
                    canvas.drawRoundRect(
                        RectF(left + dp(4f), cardTop + dp(4f), left + dp(6.6f), cardTop + dp(31f)),
                        dp(1.3f), dp(1.3f), solid(color),
                    )
                    val tx = left + dp(10f)
                    val timeText = if (event.allDay) context.getString(R.string.widget_all_day_short)
                    else CalKit.hhmm(event.start)
                    text(timePaint, timeText, tx, cardTop + dp(11f), colW - dp(16f))
                    text(titlePaint, event.summary, tx, cardTop + dp(21f), colW - dp(16f))
                    val place = event.location
                    if (!place.isNullOrBlank()) {
                        text(placePaint, place, tx, cardTop + dp(30f), colW - dp(16f))
                    }
                    cardTop += dp(39f)
                }
            }
        }

        /* --------------------------------------------- ⑤ 日程列表 4×2 / 4×4 */

        fun agendaList(snapshot: WidgetSnapshot) {
            val pad = dp(12f)
            val wideCard = wide(w, h)
            val groupsLimit = if (wideCard) 2 else 5
            val rowH = dp(16f)
            val headH = dp(22f)
            // 0.4.1（总监 m01664）：时间列固定 52dp，开始 8.4/T2/700、结束 8.0/T3 接在破折号后；
            // 名称左缘固定，不随时间文字长度抖动。
            val timeCol = dp(WidgetStats.AGENDA_TIME_COL_DP)
            val startPaint = tp(8.4f, WidgetTokens.TEXT_2, medium = true).apply { fontFeatureSettings = "tnum" }
            val endPaint = tp(8.0f, WidgetTokens.TEXT_3).apply { fontFeatureSettings = "tnum" }
            val allDayPaint = tp(8.0f, WidgetTokens.TEXT_3)
            val namePaint = tp(9.4f, WidgetTokens.TEXT)
            val placePaint = tp(8.4f, WidgetTokens.TEXT_3)
            val labelPaint = tp(8.4f, WidgetTokens.TEXT_3, medium = true)
            val emojiPaint = tp(9.2f, WidgetTokens.TEXT)
            val morePaint = tp(8.4f, WidgetTokens.TEXT_3)
            val start = CalKit.dayStart(now)
            val groups = ArrayList<Pair<Long, List<WidgetEvent>>>()
            for (offset in 0 until 14) {
                if (groups.size >= groupsLimit) break
                val day = CalKit.addDays(start, offset)
                val list = snapshot.eventsOn(CalKit.dayStart(day), CalKit.dayEnd(day))
                if (list.isNotEmpty()) groups.add(Pair(day, list))
            }
            val totalRows = groups.sumOf { it.second.size }
            // 能画几行由可用高度算出来（总监 m01915）：不写死 4/11，可用高度减去左侧 pad、
            // 头部与底部占用、每组标签与组间距后整除行高；再按组数均分，保证每天都能露一行。
            val capacity = WidgetStats.agendaCapacity(
                h,
                groups.size,
                rowH,
                dp(WidgetStats.AGENDA_LABEL_DP),
                dp(WidgetStats.AGENDA_GROUP_GAP_DP),
                pad + dp(WidgetStats.AGENDA_HEAD_DP) + dp(WidgetStats.AGENDA_HEADER_GAP_DP),
                pad + dp(WidgetStats.AGENDA_BOTTOM_DP),
            )
            val maxRows = capacity
            val groupRows = WidgetStats.agendaGroupRows(capacity, groups.map { it.second.size })
            header(
                context.getString(R.string.widget_agenda_list_title),
                context.getString(R.string.widget_count_items, totalRows),
                pad,
                if (wideCard) 12.5f else 12.5f,
                9f,
            )
            if (groups.isEmpty()) {
                textCenter(morePaint, context.getString(R.string.widget_today_none), w / 2f, (headH + h) / 2f)
                return
            }
            var y = pad + dp(12.5f) + dp(8f)
            var drawn = 0
            val bottom = h - pad - dp(10f)
            for ((groupIndex, group) in groups.withIndex()) {
                val day = group.first
                val list = group.second
                if (drawn >= maxRows) break
                if (y + dp(12f) + rowH > bottom) break
                val label = CalKit.dayMonth(day) + " " + CalKit.weekdayShort(day)
                text(labelPaint, label, pad, y + dp(8f), w - pad * 2f)
                y += dp(12f)
                var rowInGroup = 0
                val rowsHere = groupRows.getOrElse(groupIndex) { 0 }
                for (event in list) {
                    if (drawn >= maxRows) break
                    if (rowInGroup >= rowsHere) break
                    if (y + rowH > bottom) break
                    val color = event.color ?: ink
                    canvas.drawRoundRect(
                        RectF(pad, y + dp(2.5f), pad + dp(2.8f), y + dp(14f)),
                        dp(1.4f), dp(1.4f), solid(color),
                    )
                    val tx = pad + dp(WidgetStats.AGENDA_STRIP_GAP_DP)
                    val colRight = tx + timeCol
                    if (event.allDay) {
                        // 全天行：不出现破折号，「全天」右缘贴住时间列右缘。
                        text(allDayPaint, WidgetStats.AGENDA_ALL_DAY, colRight, y + dp(12f), timeCol, Paint.Align.RIGHT)
                    } else {
                        val dayEnd = CalKit.dayEnd(day)
                        val startText = CalKit.hhmm(event.start)
                        val endText = CalKit.hhmm(if (event.end > dayEnd) dayEnd else event.end)
                        val startW = text(startPaint, startText, tx, y + dp(12f), timeCol)
                        val dash = WidgetStats.agendaRangeLabel("", endText)
                        val room = colRight - (tx + startW)
                        if (room > dp(6f)) {
                            text(endPaint, dash, tx + startW, y + dp(12f), room)
                        }
                    }
                    val nameX = dp(WidgetStats.AGENDA_NAME_X_DP)
                    val emoji = tagEmojiOf(event)
                    val nameRoom = w - pad - nameX - if (emoji.isNotEmpty()) dp(14f) else 0f
                    text(namePaint, event.summary, nameX, y + dp(12f), nameRoom)
                    val place = event.location
                    if (!place.isNullOrBlank()) {
                        val nameW = namePaint.measureText(event.summary)
                        val room = w - pad - nameX - nameW - dp(4f) - if (emoji.isNotEmpty()) dp(14f) else 0f
                        if (room > dp(24f)) {
                            text(placePaint, "· " + place, nameX + nameW + dp(4f), y + dp(12f), room)
                        }
                    }
                    if (emoji.isNotEmpty()) {
                        text(emojiPaint, emoji, w - pad, y + dp(12f), dp(14f), Paint.Align.RIGHT)
                    }
                    y += rowH
                    drawn += 1
                    rowInGroup += 1
                }
                y += if (rowInGroup > 0) dp(4f) else 0f
            }
            val remaining = totalRows - drawn
            if (remaining > 0) {
                text(morePaint, context.getString(R.string.widget_more_rows, remaining), pad, h - pad - dp(2f), w - pad * 2f)
            }
        }

        /* ---------------------------------------- ⑥ 当月热度 2×2 / 4×2 */

        fun monthHeat(snapshot: WidgetSnapshot) {
            val pad = dp(12f)
            val big = wide(w, h)
            val monthStart = CalKit.monthStart(now)
            val cells = WidgetStats.monthCells(
                monthStart,
                CalKit.daysInMonth(monthStart),
                statEvents(snapshot),
            ) { day, offset -> CalKit.addDays(day, offset) }
            val busy = cells.count { it.filled }
            header(
                monthShort(now) + context.getString(R.string.widget_heat_suffix),
                context.getString(R.string.widget_heat_meta, cells.sumOf { it.count }, busy),
                pad,
                if (big) 12.5f else 11.5f,
                if (big) 9f else 8.2f,
            )
            val weekPaint = tp(if (big) 7.8f else 6.6f, WidgetTokens.TEXT_3)
            val labels = CalKit.weekLabels(snapshot.weekStartsOn)
            val cl = (w - pad * 2f) / 7f
            val bodyTop = pad + dp(if (big) 22f else 18f)
            val legendH = if (big) dp(14f) else dp(12f)
            val gapY = dp(if (big) 2.6f else 2f)
            for (col in 0 until 7) {
                textCenter(weekPaint, labels[col], pad + cl * col + cl / 2f, bodyTop + dp(6f))
            }
            val gridTop = bodyTop + dp(11f)
            val cellH = minOf(
                dp(14f),
                (h - pad - legendH - gridTop - gapY * 5f) / 6f,
            ).coerceAtLeast(dp(6f))
            val cellW = cl - dp(if (big) 5f else 4f)
            val radius = dp(if (big) 4f else 3f)
            val lead = CalKit.weekdayIndex(monthStart, snapshot.weekStartsOn)
            for (index in cells.indices) {
                val slot = lead + index
                val row = slot / 7
                val col = slot % 7
                val cx = pad + cl * col + cl / 2f
                val cy = gridTop + (cellH + gapY) * row
                val cell = cells[index]
                rect.set(cx - cellW / 2f, cy, cx + cellW / 2f, cy + cellH)
                canvas.drawRoundRect(rect, radius, radius, solid(dayCellColor(cell)))
                if (CalKit.isSameDay(cell.dayStart, now)) {
                    val ring = stroke(ink, if (big) 1.8f else 1.5f)
                    val grow = dp(if (big) 1.6f else 1.4f)
                    rect.set(cx - cellW / 2f - grow, cy - grow, cx + cellW / 2f + grow, cy + cellH + grow)
                    canvas.drawRoundRect(rect, radius + dp(1.2f), radius + dp(1.2f), ring)
                }
                if (cell.filled && cell.emoji.isNotEmpty()) {
                    val paint = tp(if (big) cellH / density * 0.78f else cellH / density * 0.72f, WidgetTokens.TEXT)
                    textCenter(paint, cell.emoji, cx, cy + cellH / 2f + dp(if (big) 2f else 1.8f))
                }
            }
            // 图例：少 + 四档 + 多
            val legendBaseline = h - pad - dp(2f)
            val legendPaint = tp(if (big) 7.4f else 6.8f, WidgetTokens.TEXT_3)
            text(legendPaint, context.getString(R.string.widget_legend_less), pad, legendBaseline, dp(12f))
            val swatch = dp(if (big) 6.6f else 5.2f)
            val base = WidgetTokens.CALENDAR_PALETTE[0]
            val steps = listOf(0, 1, 2, 3)
            val originX = pad + dp(if (big) 10f else 8f)
            steps.forEachIndexed { index, step ->
                val color = when (step) {
                    0 -> WidgetTokens.EMPTY_CELL
                    1 -> WidgetTokens.tintWhite(base, 0.42f)
                    2 -> WidgetTokens.tintWhite(base, 0.76f)
                    else -> base
                }
                rect.set(
                    originX + (swatch + dp(1f)) * index,
                    legendBaseline - swatch,
                    originX + (swatch + dp(1f)) * index + swatch,
                    legendBaseline,
                )
                canvas.drawRoundRect(rect, dp(1.4f), dp(1.4f), solid(color))
            }
            text(
                legendPaint,
                context.getString(R.string.widget_legend_more),
                originX + (swatch + dp(1f)) * 4 + dp(2f),
                legendBaseline,
                dp(12f),
            )
        }

        /* ---------------------------------------- ⑦ 当月分类 2×2 / 4×2 */

        fun monthCategory(snapshot: WidgetSnapshot) {
            val pad = dp(12f)
            val big = wide(w, h)
            val events = statEvents(snapshot).filter { !it.allDay }
            val rows = WidgetStats.categories(events, if (big) 5 else 5)
            header(
                monthShort(now) + context.getString(R.string.widget_category_suffix),
                context.getString(R.string.widget_category_meta, events.size, rows.size),
                pad,
                if (big) 12.5f else 11.5f,
                if (big) 9f else 8.2f,
            )
            if (rows.isEmpty()) {
                textCenter(
                    tp(9f, WidgetTokens.TEXT_3),
                    context.getString(R.string.widget_today_none),
                    w / 2f,
                    h / 2f,
                )
                return
            }
            val maxCount = rows.maxOf { it.count }
            val top = pad + dp(if (big) 24f else 20f)
            val rowSpan = (h - pad - top) / maxOf(rows.size, if (big) 4 else 3).toFloat()
            val emojiPaint = tp(if (big) 9f else 8.4f, WidgetTokens.TEXT)
            val namePaint = tp(if (big) 9f else 8.8f, WidgetTokens.TEXT_2)
            val countPaint = tp(if (big) 9f else 8.4f, WidgetTokens.TEXT, medium = true)
            val barH = dp(if (big) 9.2f else 3.2f)
            val barX = pad + dp(if (big) 48f else 40f)
            val countRoom = dp(22f)
            val barW = w - pad - countRoom - barX
            rows.forEachIndexed { index, row ->
                val cy = top + rowSpan * index + rowSpan / 2f
                if (row.emoji.isNotEmpty()) {
                    text(emojiPaint, row.emoji, pad, cy + dp(3f), dp(14f))
                }
                val nameX = pad + dp(if (big) 16f else 14f)
                text(namePaint, row.name, nameX, cy + dp(3f), barX - nameX - dp(2f))
                rect.set(barX, cy - barH / 2f, barX + barW, cy + barH / 2f)
                canvas.drawRoundRect(rect, barH / 2f, barH / 2f, solid(WidgetTokens.TRACK))
                val fillW = barW * WidgetStats.categoryBarRatio(row.count, maxCount)
                if (fillW > 0f) {
                    rect.set(barX, cy - barH / 2f, barX + maxOf(fillW, barH), cy + barH / 2f)
                    canvas.drawRoundRect(rect, barH / 2f, barH / 2f, solid(row.colorArgb))
                }
                text(countPaint, row.count.toString(), w - pad, cy + dp(3f), countRoom, Paint.Align.RIGHT)
            }
        }

        /* ---------------------------------------- ⑧ 一周节奏 2×2 / 4×2 */

        fun weekRhythm(snapshot: WidgetSnapshot) {
            val pad = dp(12f)
            val big = wide(w, h)
            val weekStartsOn = snapshot.weekStartsOn
            val todayStart = CalKit.dayStart(now)
            val weekStart = CalKit.addDays(todayStart, -CalKit.weekdayIndex(now, weekStartsOn))
            val bars = WidgetStats.weekBars(
                weekStart,
                weekStartsOn,
                CalKit.weekLabels(weekStartsOn),
                statEvents(snapshot),
                todayStart,
            ) { day, offset -> CalKit.addDays(day, offset) }
            val max = WidgetStats.maxBar(bars)
            val peak = WidgetStats.peakBar(bars)
            header(
                context.getString(R.string.widget_week_rhythm_title),
                if (peak == null) null
                else context.getString(R.string.widget_week_peak, peak.label, peak.count),
                pad,
                if (big) 12.5f else 11.5f,
                if (big) 9f else 8.2f,
            )
            val top = pad + dp(if (big) 30f else 22f)
            val base = h - pad - dp(if (big) 10f else 11f)
            val colW = (w - pad * 2f) / 7f
            val barW = dp(if (big) 16f else 12f)
            val barRadius = dp(if (big) 5f else 4f)
            val countPaint = tp(if (big) 7.6f else 6.8f, WidgetTokens.TEXT_2, medium = true)
            val labelPaint = tp(if (big) 7.6f else 6.8f, WidgetTokens.TEXT_3)
            val firstLabelPaint = tp(if (big) 7.6f else 6.8f, ink, medium = true)
            bars.forEachIndexed { index, bar ->
                val cx = pad + colW * index + colW / 2f
                if (bar.count <= 0) {
                    rect.set(cx - barW / 2f, base - dp(2f), cx + barW / 2f, base)
                    canvas.drawRoundRect(rect, dp(1f), dp(1f), solid(WidgetTokens.ZERO_BAR))
                } else {
                    val ratio = bar.ratio(max)
                    val minH = dp(if (big) 7f else 4f)
                    val barH = maxOf(minH, (base - top) * ratio)
                    rect.set(cx - barW / 2f, base - barH, cx + barW / 2f, base)
                    canvas.drawRoundRect(rect, barRadius, barRadius, solid(WidgetTokens.weekColor(ink, ratio)))
                    textCenter(countPaint, bar.count.toString(), cx, base - barH - dp(3f))
                }
                val labelPaintFor = if (index == 0) firstLabelPaint else labelPaint
                textCenter(labelPaintFor, bar.label, cx, h - pad, )
            }
        }

        /* ---------------------------------------- ⑨ 时段分析 2×2 / 4×2 */

        fun hours(snapshot: WidgetSnapshot) {
            val pad = dp(12f)
            val big = wide(w, h)
            val monthStart = CalKit.monthStart(now)
            val monthEnd = CalKit.addMonths(monthStart, 1)
            val inMonth = statEvents(snapshot).filter { it.start >= monthStart && it.start < monthEnd }
            val counts = WidgetStats.hourCounts(inMonth) { millis -> CalKit.hourOf(millis) }
            val peak = WidgetStats.peakHour(counts)
            header(
                context.getString(R.string.widget_hours_title),
                if (peak < 0) null
                else context.getString(R.string.widget_hours_peak, peak, WidgetStats.totalOf(counts)),
                pad,
                if (big) 12.5f else 11.5f,
                if (big) 9f else 8.2f,
            )
            val top = pad + dp(if (big) 20f else 24f)
            val base = h - pad - dp(9f)
            val max = counts.maxOrNull() ?: 0
            if (max <= 0) {
                textCenter(
                    tp(if (big) 9f else 8.2f, WidgetTokens.TEXT_3),
                    context.getString(R.string.widget_today_none),
                    w / 2f,
                    (top + base) / 2f,
                )
                return
            }
            val gx = pad
            val gw = w - pad * 2f
            val points = (0 until 24).map { hour ->
                val x = gx + gw * hour / 23f
                val y = base - (base - top) * (counts[hour].toFloat() / max.toFloat())
                Pair(x, y)
            }
            val curve = WidgetStats.catmullRom(points, 12)
            path.reset()
            path.moveTo(curve[0].first, curve[0].second)
            for (index in 1 until curve.size) path.lineTo(curve[index].first, curve[index].second)
            // 渐变填充：主题墨色 0.30 → 0.02（不许写死蓝）
            val fillPath = Path(path)
            fillPath.lineTo(curve.last().first, base)
            fillPath.lineTo(curve.first().first, base)
            fillPath.close()
            val shader = android.graphics.LinearGradient(
                0f, top, 0f, base,
                WidgetTokens.withAlpha(ink, 0.30f),
                WidgetTokens.withAlpha(ink, 0.02f),
                android.graphics.Shader.TileMode.CLAMP,
            )
            val fillPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
                style = Paint.Style.FILL
                this.shader = shader
            }
            canvas.drawPath(fillPath, fillPaint)
            // 0.4.1（CI run 43815981359 修复）：android.graphics.Paint 的拐角属性叫 strokeJoin；
            // Skia / Compose 层的同名写法在这个类上不存在（防回归，name 不再写原拼法）。
            canvas.drawPath(path, stroke(ink, if (big) 1.8f else 1.6f).apply { strokeJoin = Paint.Join.ROUND })
            if (peak >= 0) {
                canvas.drawCircle(points[peak].first, points[peak].second, dp(1.7f), solid(ink))
            }
            val axisPaint = tp(if (big) 7.4f else 6.6f, WidgetTokens.TEXT_3)
            val axisBaseline = h - pad
            if (big) {
                listOf(0 to "0点", 6 to "6点", 12 to "12点", 18 to "18点", 23 to "23点").forEach { (hour, label) ->
                    val x = gx + gw * hour / 23f
                    val align = when (hour) {
                        0 -> Paint.Align.LEFT
                        23 -> Paint.Align.RIGHT
                        else -> Paint.Align.CENTER
                    }
                    val paint = tp(7.4f, WidgetTokens.TEXT_3)
                    paint.textAlign = align
                    val dx = when (align) {
                        Paint.Align.LEFT -> x
                        Paint.Align.RIGHT -> x
                        else -> x
                    }
                    canvas.drawText(label, dx, axisBaseline, paint)
                }
            } else {
                val left = tp(6.6f, WidgetTokens.TEXT_3)
                val right = tp(6.6f, WidgetTokens.TEXT_3).apply { textAlign = Paint.Align.RIGHT }
                canvas.drawText("0", gx, axisBaseline, left)
                canvas.drawText("23", w - pad, axisBaseline, right)
            }
        }

        /* ------------------------------------------------------ 占位 / 页脚 */

        fun placeholder() {
            val pad = dp(14f)
            val titlePaint = tp(12.5f, WidgetTokens.TEXT, medium = true)
            val hintPaint = tp(9.5f, WidgetTokens.TEXT_3)
            textCenter(titlePaint, context.getString(R.string.widget_no_token), w / 2f, h / 2f - dp(4f))
            textCenter(hintPaint, context.getString(R.string.widget_no_token_hint), w / 2f, h / 2f + dp(14f))
        }

        fun staleFooter(snapshot: WidgetSnapshot) {
            val updated = WidgetPrefs.lastUpdated(context)
            val error = WidgetPrefs.lastError(context)
            if (updated <= 0L || error.isNullOrBlank()) return
            val paint = tp(7.2f, WidgetTokens.TEXT_3)
            val text = context.getString(R.string.widget_updated, CalKit.hhmm(updated))
            val wText = paint.measureText(text)
            if (wText > w * 0.6f) return
            val bx = w - dp(12f) - wText - dp(4f)
            rect.set(bx, h - dp(15f), w - dp(12f), h - dp(9f))
            canvas.drawRoundRect(rect, dp(3f), dp(3f), solid(WidgetTokens.WHITE))
            canvas.drawText(text, bx + dp(2f), h - dp(11f), paint)
        }
    }
}
