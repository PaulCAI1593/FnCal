package com.paulcai1593.fncal.app

/**
 * 0.4.1 桌卡统计（纯 Kotlin，可在 JVM 单测里直接跑，不依赖 android.graphics）。
 *
 * 为什么单独一层：设计定稿里的四档、分类前 5、一周节奏、时段曲线都是纯算术，
 * 放在渲染器里就没法在 CI 的 JVM 单测里断言。渲染器只负责画，这里只负责算。
 *
 * 口径（与网页年度总结同源）：
 *   - 一天的颜色 = 该天**条数最多**的日历的颜色；并列取当天最早那条所在日历；
 *   - 一天的 emoji = 该日历下当天第一条日程的分类 emoji，没有分类则取分类名首字，再没有就用日历名首字；
 *   - 分类行 = 分类名聚合，颜色取分组十色（`groupOrder`），未分组用 `UNGROUPED`，按条数降序、并列按分组顺序；
 *   - 一周节奏 = 当前这一周（按设置的一周起始）每天的日程条数；
 *   - 时段分析 = 当天开始的非全天日程按小时计数，峰值取原始最大值、并列取最早小时。
 */
object WidgetStats {

    /** 徽章每行 2 个、最多 2 行（设计定稿）。 */
    const val BADGE_PER_ROW = 2
    const val BADGE_MAX_ROWS = 2

    /** 日程列表的时间列宽度：固定 52dp，名称左缘因此不随文字长短抖动。 */
    const val AGENDA_TIME_COL_DP = 52f

    /** 日程列表的全天行文案：不带破折号，右对齐到时间列右缘。 */
    const val AGENDA_ALL_DAY = "全天"

    /**
     * 日程列表的横向几何（dp），渲染器与单测共用同一份常量：
     * 左边距 12 → 色条间隙 7 → 时间列 52 → 名称前 4。
     * 名称左缘因此恒为 75dp，任何一行的名称都从同一条竖线开始。
     */
    const val AGENDA_PAD_DP = 12f
    const val AGENDA_STRIP_GAP_DP = 7f
    const val AGENDA_NAME_GAP_DP = 4f
    const val AGENDA_TIME_COL_RIGHT_DP = AGENDA_PAD_DP + AGENDA_STRIP_GAP_DP + AGENDA_TIME_COL_DP
    const val AGENDA_NAME_X_DP = AGENDA_TIME_COL_RIGHT_DP + AGENDA_NAME_GAP_DP

    /** 日程列表一行的高度与组标签高度（dp）。 */
    const val AGENDA_ROW_DP = 16f
    const val AGENDA_LABEL_DP = 12f
    const val AGENDA_GROUP_GAP_DP = 2f

    /** 日程列表的固定占用：首行基线 12.5 + 头部间距 8、底部 10（不含 pad，由调用方传入）。 */
    const val AGENDA_HEAD_DP = 12.5f
    const val AGENDA_HEADER_GAP_DP = 8f
    const val AGENDA_BOTTOM_DP = 10f

    /**
     * 日程列表能画几行，由**可用高度**算出来，不写死。
     *
     * `可用高度 = height - top - bottom - groupCount × (标签 + 组间距)`，再整除行高。
     * 组数越多，标签吃掉的高度越多，能画的条数越少 —— 这正是「4×2 放 2 组、4×4 放 5 组」
     * 在真机上的差别，不能用一个常量代替。
     *
     * @param heightPx 卡片高度（与其它参数同单位）
     * @param groupCount 实际有日程的天数（≤ 5）
     */
    fun agendaCapacity(
        heightPx: Float,
        groupCount: Int,
        rowPx: Float,
        labelPx: Float,
        groupGapPx: Float,
        topPx: Float,
        bottomPx: Float,
    ): Int {
        if (groupCount <= 0) return 0
        val usable = heightPx - topPx - bottomPx - groupCount * (labelPx + groupGapPx)
        if (usable <= 0f) return 0
        return (usable / rowPx).toInt()
    }

    /**
     * 把可用行数轮流分给每一天：容量够时每组的条数尽量接近（4 条 / 2 组 → 2 + 2；
     * 7 条 / 5 组 → 2 + 2 + 1 + 1 + 1），避免第一组把整卡占满、后面几天一条都看不到。
     * 返回每组实际画的行数，`sum()` 即已画条数。
     */
    fun agendaGroupRows(capacity: Int, groupSizes: List<Int>): IntArray {
        val rows = IntArray(groupSizes.size)
        if (capacity <= 0 || groupSizes.isEmpty()) return rows
        var left = capacity
        var progressed = true
        while (left > 0 && progressed) {
            progressed = false
            for (index in groupSizes.indices) {
                if (left <= 0) break
                if (rows[index] < groupSizes[index]) {
                    rows[index] += 1
                    left -= 1
                    progressed = true
                }
            }
        }
        return rows
    }

    /** 日程列表一行的时间文案：`09:00–10:30`（开始–结束）。 */
    fun agendaRangeLabel(start: String, end: String): String = "$start–$end"

    /** 卡片统计用的一条日程（与 `WidgetEvent` 解耦，便于单测）。 */
    data class StatEvent(
        val start: Long,
        val end: Long,
        val allDay: Boolean,
        val calendarKey: String,
        val calendarName: String,
        val calendarColor: Int,
        /** 标签 emoji（接口 `tagEmoji`），无标签为 null。 */
        val tagEmoji: String? = null,
        /** 标签所在分组名（接口 `tagGroupName`），无标签 / 未分组为 null。 */
        val tagGroupName: String? = null,
        /** 分组在设置里的顺序（接口 `tagGroupIndex`，从 0 开始），-1 = 未分组 / 无分组。 */
        val tagGroupIndex: Int = -1,
    ) {
        /** 这条日程在「分类」里的名字：有分组用分组名，没有就用日历名（降级口径）。 */
        val categoryName: String get() = tagGroupName?.takeIf { it.isNotBlank() } ?: calendarName

        /** 分类 emoji：先取接口给的 tag emoji，再取分组名首字，最后用日历名首字。 */
        fun categoryEmoji(): String {
            val explicit = tagEmoji?.trim().orEmpty()
            if (explicit.isNotEmpty()) return explicit
            val group = tagGroupName?.trim().orEmpty()
            return firstChar(group.ifBlank { calendarName })
        }

        /**
         * 分类条颜色：分组下标 ≥ 0 用分组十色（与年度总结同板同序）；
         * 有分组但没给下标 → 未分组色；完全没有标签数据 → 日历色（接口未扩展时的降级）。
         */
        fun categoryColor(): Int = when {
            tagGroupIndex >= 0 -> WidgetTokens.groupColorAt(tagGroupIndex)
            !tagGroupName.isNullOrBlank() -> WidgetTokens.UNGROUPED
            else -> calendarColor
        }

        /**
         * 大月历徽章是否实底：全天、或这天只是多日日程中的一天 → 实底；
         * 只有「当天开始且当天结束」的定时日程才算淡底。
         */
        fun solidOn(dayStart: Long, dayEnd: Long): Boolean =
            allDay || start < dayStart || end > dayEnd
    }

    /** 大月历的一枚徽章。 */
    data class Badge(
        val emoji: String,
        /** 填充色：实底 = 日历色，淡底 = 日历色 30% 叠白。 */
        val fillColor: Int,
        /** 淡底的细边色（同色 50% 叠白）；实底为 null。 */
        val ringColor: Int?,
        val solid: Boolean,
    )

    /** 热度/徽章用的一格（一天）。 */
    data class DayCell(
        val dayStart: Long,
        val count: Int,
        val colorArgb: Int,
        val emoji: String,
        val badges: List<Badge> = emptyList(),
    ) {
        val level: Int get() = WidgetTokens.heatLevel(count)
        val filled: Boolean get() = count > 0
    }

    /** 分类一行。 */
    data class CategoryRow(
        val name: String,
        val emoji: String,
        val count: Int,
        val colorArgb: Int,
        val groupOrder: Int,
    )

    /** 一周节奏的一根柱子。 */
    data class WeekBar(val label: String, val count: Int, val isToday: Boolean) {
        /** 相对最高值的比例，全部为 0 时也返回 0。 */
        fun ratio(max: Int): Float = if (max <= 0) 0f else count.toFloat() / max.toFloat()

        fun alpha(max: Int): Float = if (count <= 0) 0f else WidgetTokens.weekAlpha(ratio(max))
    }

    /** 取第一个字符（emoji 视为一个字符；代理对按一对取，避免半个字）。 */
    fun firstChar(value: String?): String {
        if (value.isNullOrEmpty()) return ""
        val first = value[0]
        if (Character.isHighSurrogate(first) && value.length >= 2) {
            return value.substring(0, 2)
        }
        return first.toString()
    }

    /**
     * 某一天的「主日历」与 emoji。
     *
     * `events` 必须已按当天过滤；同一日历的条数最多者胜出，并列时取当天最早的一条
     * （调用方保证 events 按开始时间升序）。
     */
    fun mainEvent(events: List<StatEvent>): StatEvent? {
        if (events.isEmpty()) return null
        val counts = LinkedHashMap<String, Int>()
        for (event in events) {
            counts[event.calendarKey] = (counts[event.calendarKey] ?: 0) + 1
        }
        var winner = events[0]
        var best = -1
        for ((key, count) in counts) {
            if (count > best) {
                best = count
                winner = events.first { it.calendarKey == key }
            }
        }
        return winner
    }

    /**
     * 当月的日热度格：下标 0 = 当月 1 日。
     *
     * `days` 是当月天数；`events` 里不属于当月的会被忽略。
     */
    fun monthCells(
        monthStart: Long,
        days: Int,
        events: List<StatEvent>,
        addDays: (Long, Int) -> Long,
    ): List<DayCell> {
        val out = ArrayList<DayCell>(days)
        for (index in 0 until days) {
            val day = addDays(monthStart, index)
            val dayEnd = addDays(day, 1)
            val todays = events.filter { it.start < dayEnd && it.end > day }
                .sortedBy { if (it.allDay) Long.MIN_VALUE else it.start }
            val main = mainEvent(todays)
            val badges = todays.take(4).map { event ->
                val solid = event.solidOn(day, dayEnd)
                Badge(
                    emoji = event.categoryEmoji(),
                    fillColor = WidgetTokens.badgeFill(event.calendarColor, solid),
                    ringColor = if (solid) null else WidgetTokens.badgeRing(event.calendarColor),
                    solid = solid,
                )
            }
            out.add(
                DayCell(
                    dayStart = day,
                    count = todays.size,
                    colorArgb = main?.calendarColor ?: WidgetTokens.EMPTY_CELL,
                    emoji = main?.categoryEmoji().orEmpty(),
                    badges = badges,
                )
            )
        }
        return out
    }

    /** 日热度格的颜色（空格 → 底色）。 */
    fun heatCellColor(cell: DayCell, ink: Int): Int {
        if (!cell.filled) return WidgetTokens.EMPTY_CELL
        return WidgetTokens.heatColor(cell.colorArgb, cell.count)
    }

    /**
     * 分类分布：按分类名聚合，最多 `limit` 行（默认 5）。
     *
     * 排序：条数降序 → 分组顺序升序（有分组的在前）→ 名称。与年度总结的并列口径一致。
     */
    fun categories(events: List<StatEvent>, limit: Int = 5): List<CategoryRow> {
        val buckets = LinkedHashMap<String, CategoryRow>()
        for (event in events) {
            if (event.allDay) continue
            val name = event.categoryName
            if (name.isBlank()) continue
            val existing = buckets[name]
            buckets[name] = if (existing == null) {
                CategoryRow(
                    name = name,
                    emoji = event.categoryEmoji(),
                    count = 1,
                    colorArgb = event.categoryColor(),
                    groupOrder = event.tagGroupIndex,
                )
            } else {
                existing.copy(count = existing.count + 1)
            }
        }
        return buckets.values
            .sortedWith(
                compareByDescending<CategoryRow> { it.count }
                    .thenBy { if (it.groupOrder >= 0) it.groupOrder else Int.MAX_VALUE }
                    .thenBy { it.name }
            )
            .take(limit.coerceAtLeast(0))
    }

    /** 分类条长度：按当前最大值等比，最大值至少 1。 */
    fun categoryBarRatio(count: Int, max: Int): Float {
        if (max <= 0 || count <= 0) return 0f
        return (count.toFloat() / max.toFloat()).coerceIn(0f, 1f)
    }

    /**
     * 当前这一周每天的条数（数组下标 0 = 该周第一天）。
     *
     * `weekStart` 是该周第一天的 0 点；`weekdays(n)` 取第 n 天（n 从 0 起）。
     */
    fun weekBars(
        weekStart: Long,
        weekStartsOn: Int,
        labels: Array<String>,
        events: List<StatEvent>,
        todayStart: Long,
        addDays: (Long, Int) -> Long,
    ): List<WeekBar> {
        val bars = ArrayList<WeekBar>(7)
        for (index in 0 until 7) {
            val day = addDays(weekStart, index)
            val dayEnd = addDays(day, 1)
            val count = events.count { it.start < dayEnd && it.end > day }
            bars.add(
                WeekBar(
                    label = labels.getOrElse(index) { "" },
                    count = count,
                    isToday = day == todayStart,
                )
            )
        }
        return bars
    }

    /** 一周节奏的最大条数（全 0 时返回 0，渲染器画底线）。 */
    fun maxBar(bars: List<WeekBar>): Int = bars.maxOfOrNull { it.count } ?: 0

    /** 条数最多的那一根（并列取最早），全 0 返回 null。 */
    fun peakBar(bars: List<WeekBar>): WeekBar? {
        val max = maxBar(bars)
        if (max <= 0) return null
        return bars.first { it.count == max }
    }

    /** 时段分析的 24 个小时计数（只统计非全天、且开始于该小时的日程）。 */
    fun hourCounts(events: List<StatEvent>, hourOf: (Long) -> Int): IntArray {
        val out = IntArray(24)
        for (event in events) {
            if (event.allDay) continue
            val hour = hourOf(event.start)
            if (hour in 0..23) out[hour] += 1
        }
        return out
    }

    /** 峰值小时：取原始最大值、并列取最早；全 0 返回 -1。 */
    fun peakHour(counts: IntArray): Int {
        var best = -1
        var bestValue = 0
        for (index in counts.indices) {
            if (counts[index] > bestValue) {
                bestValue = counts[index]
                best = index
            }
        }
        return best
    }

    /** 非零的小时条数之和（标题里的「N 条」）。 */
    fun totalOf(counts: IntArray): Int = counts.sum()

    /**
     * Catmull-Rom 平滑：把 24 个点连成曲线，每段 `samples` 个采样点。
     *
     * 端点用「复制首尾」处理，曲线不会越界。返回值与输入同数量的段（每段内采样）。
     */
    fun catmullRom(
        points: List<Pair<Float, Float>>,
        samples: Int = 12,
    ): List<Pair<Float, Float>> {
        if (points.isEmpty()) return emptyList()
        if (points.size == 1) return points
        val steps = samples.coerceAtLeast(2)
        val out = ArrayList<Pair<Float, Float>>(points.size * steps)
        for (index in 0 until points.size - 1) {
            val p0 = points[if (index - 1 >= 0) index - 1 else 0]
            val p1 = points[index]
            val p2 = points[index + 1]
            val p3 = points[if (index + 2 < points.size) index + 2 else points.size - 1]
            for (step in 0 until steps) {
                val t = step.toFloat() / steps.toFloat()
                out.add(Pair(catmullRomAt(p0.first, p1.first, p2.first, p3.first, t), catmullRomAt(p0.second, p1.second, p2.second, p3.second, t)))
            }
        }
        out.add(points[points.size - 1])
        return out
    }

    private fun catmullRomAt(v0: Float, v1: Float, v2: Float, v3: Float, t: Float): Float {
        val t2 = t * t
        val t3 = t2 * t
        return 0.5f * (
            (2f * v1) +
                (-v0 + v2) * t +
                (2f * v0 - 5f * v1 + 4f * v2 - v3) * t2 +
                (-v0 + 3f * v1 - 3f * v2 + v3) * t3
            )
    }

    /**
     * 大月历的徽章偏移：每行 2 个、最多 2 行、直径 11.2dp、间距 2.8dp。
     *
     * 返回相对格子中心的偏移（x, y），下标 0 起；超过 4 条只画 4 个。
     */
    fun badgeOffsets(
        count: Int,
        diameter: Float = WidgetTokens.BADGE_DIAMETER_DP,
        gap: Float = WidgetTokens.BADGE_GAP_DP,
        maxRows: Int = BADGE_MAX_ROWS,
    ): List<Pair<Float, Float>> {
        val limit = maxRows * BADGE_PER_ROW
        val shown = count.coerceIn(0, limit)
        if (shown == 0) return emptyList()
        val dx = (diameter + gap) / 2f
        val out = ArrayList<Pair<Float, Float>>(shown)
        for (index in 0 until shown) {
            val row = index / BADGE_PER_ROW
            val col = index % BADGE_PER_ROW
            val x = if (col == 0) -dx else dx
            // 设计稿：徽章第一行圆心在格内 +21dp、行距 (直径 + 间距) = 14dp；相对格子中心即 0 / 14。
            val y = row * (diameter + gap)
            out.add(Pair(x, y))
        }
        return out
    }

    /** 徽章 emoji 尺寸 = 直径 × 0.62（设计定稿）。 */
    fun badgeEmojiSize(diameter: Float = WidgetTokens.BADGE_DIAMETER_DP): Float = diameter * 0.62f
}
