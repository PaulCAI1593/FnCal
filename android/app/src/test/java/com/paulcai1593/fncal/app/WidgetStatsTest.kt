package com.paulcai1593.fncal.app

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.util.Calendar

/**
 * 0.4.1 桌卡统计口径：徽章实底/淡底、分类前 5 与并列顺序、一周起始两种设置、
 * 时段峰值、日程列表的时间列与全天文案。
 *
 * 与设计定稿 `projects/FnCal/design/widget-design/设计结论.md` 一一对应；
 * 全部纯 Kotlin，本机 JVM 可跑（无需模拟器）。
 */
class WidgetStatsTest {

    private val dayMillis = 24L * 60 * 60 * 1000

    private fun at(year: Int, month: Int, day: Int, hour: Int, minute: Int = 0): Long {
        val cal = Calendar.getInstance()
        cal.set(year, month, day, hour, minute, 0)
        cal.set(Calendar.MILLISECOND, 0)
        return cal.timeInMillis
    }

    private fun dayStart(millis: Long): Long {
        val cal = Calendar.getInstance()
        cal.timeInMillis = millis
        cal.set(Calendar.HOUR_OF_DAY, 0)
        cal.set(Calendar.MINUTE, 0)
        cal.set(Calendar.SECOND, 0)
        cal.set(Calendar.MILLISECOND, 0)
        return cal.timeInMillis
    }

    private fun addDays(millis: Long, days: Int): Long = millis + days * dayMillis

    private fun event(
        start: Long,
        end: Long,
        allDay: Boolean = false,
        calendarKey: String = "c1",
        calendarName: String = "工作",
        calendarColor: Int = WidgetTokens.CALENDAR_PALETTE[0],
        tagEmoji: String? = null,
        tagGroupName: String? = null,
        tagGroupIndex: Int = -1,
    ): WidgetStats.StatEvent = WidgetStats.StatEvent(
        start = start,
        end = end,
        allDay = allDay,
        calendarKey = calendarKey,
        calendarName = calendarName,
        calendarColor = calendarColor,
        tagEmoji = tagEmoji,
        tagGroupName = tagGroupName,
        tagGroupIndex = tagGroupIndex,
    )

    @Test
    fun monthCellBadgesDifferForAllDayAndTimedEvent() {
        val today = dayStart(at(2026, 10, 16, 12))
        val allDay = event(today, addDays(today, 1), allDay = true)
        val timed = event(at(2026, 10, 16, 9), at(2026, 10, 16, 10, 30))
        val cell = WidgetStats.monthCells(today, 1, listOf(allDay, timed), ::addDays).single()

        assertEquals(2, cell.badges.size)
        val solid = cell.badges.first { it.solid }
        val soft = cell.badges.first { !it.solid }
        assertEquals("全天那枚 = 日历色实底", WidgetTokens.CALENDAR_PALETTE[0], solid.fillColor)
        assertEquals("淡底那枚 = 30% 叠白", WidgetTokens.overWhite(WidgetTokens.CALENDAR_PALETTE[0], 0.30f), soft.fillColor)
        assertTrue("两枚填充色必须不同", solid.fillColor != soft.fillColor)
        assertTrue(
            "定时那枚应明显淡：对白底 < 1.5:1",
            WidgetTokens.contrast(soft.fillColor, 0xFFFFFFFF.toInt()) < 1.5,
        )
        assertNotNull("淡底必须带细边", soft.ringColor)
        assertNull("实底不画细边", solid.ringColor)
    }

    @Test
    fun multiDayEventIsSolidOnEveryDayItCovers() {
        val first = dayStart(at(2026, 10, 16, 12))
        val startAt = at(2026, 10, 16, 22)
        val endAt = at(2026, 10, 18, 4)
        val multi = event(startAt, endAt)
        val cells = WidgetStats.monthCells(first, 3, listOf(multi), ::addDays)
        for (cell in cells) {
            assertTrue("多日日程每天都应是实底：${cell.dayStart}", cell.badges.single().solid)
        }
    }

    @Test
    fun categoriesKeepTopFiveWithGroupOrderTieBreak() {
        val base = at(2026, 10, 16, 9)
        val events = ArrayList<WidgetStats.StatEvent>()
        // 学习 3 条、工作 3 条（并列，按分组顺序：工作 index 1 排在 学习 index 2 前）、生活 2 条、运动 1 条、杂事 1 条、第六类 1 条。
        val specs = listOf(
            Triple("学习", "📚", 2) to 3,
            Triple("工作", "💼", 1) to 3,
            Triple("生活", "🏠", 3) to 2,
            Triple("运动", "🏃", 4) to 1,
            Triple("杂事", "🧾", 5) to 1,
            Triple("第六类", "🧪", 6) to 1,
        )
        for ((spec, count) in specs) {
            val (name, emoji, order) = spec
            for (index in 0 until count) {
                events.add(
                    event(
                        start = base + index * 3600_000L,
                        end = base + index * 3600_000L + 1800_000L,
                        tagEmoji = emoji,
                        tagGroupName = name,
                        tagGroupIndex = order,
                    )
                )
            }
        }
        // 全天日程不计入分类（设计定稿：分类只统计定时日程）。
        events.add(event(dayStart(base), addDays(dayStart(base), 1), allDay = true, tagGroupName = "学习", tagGroupIndex = 2))

        val rows = WidgetStats.categories(events)
        assertEquals("最多 5 行", 5, rows.size)
        assertEquals("第一行条数最多", 3, rows[0].count)
        assertEquals("并列按分组顺序：工作(1) 在 学习(2) 前", "工作", rows[0].name)
        assertEquals("学习", rows[1].name)
        assertEquals("生活", rows[2].name)
        assertEquals("运动", rows[3].name)
        assertEquals("杂事", rows[4].name)
        assertTrue("第六类被截掉", rows.none { it.name == "第六类" })
        assertEquals("emoji 取接口给的 tagEmoji", "💼", rows[0].emoji)
        assertEquals("颜色取分组十色", WidgetTokens.GROUP_PALETTE[1], rows[0].colorArgb)
    }

    @Test
    fun categoryColorFallsBackWhenGroupDataMissing() {
        val noTag = event(at(2026, 10, 16, 9), at(2026, 10, 16, 10))
        assertEquals("无标签 → 日历色降级", WidgetTokens.CALENDAR_PALETTE[0], noTag.categoryColor())
        assertEquals("无标签 → 分类名用日历名", "工作", noTag.categoryName)

        val groupNoIndex = event(at(2026, 10, 16, 9), at(2026, 10, 16, 10), tagGroupName = "已删分组")
        assertEquals("有分组名无下标 → 未分组色", WidgetTokens.UNGROUPED, groupNoIndex.categoryColor())
    }

    @Test
    fun weekBarsFollowWeekStartSetting() {
        val monday = at(2026, 10, 16, 0) // 2026-11-16 是周一
        val events = listOf(
            event(at(2026, 10, 16, 9), at(2026, 10, 16, 10)),
            event(at(2026, 10, 16, 14), at(2026, 10, 16, 15)),
            event(at(2026, 10, 18, 9), at(2026, 10, 18, 10)),
        )
        val labels = arrayOf("一", "二", "三", "四", "五", "六", "日")

        val mondayStart = WidgetStats.weekBars(monday, 1, labels, events, monday, ::addDays)
        assertEquals(2, mondayStart[0].count)
        assertTrue("今天那根要标出来", mondayStart[0].isToday)
        assertEquals(0, mondayStart[1].count)
        assertEquals(1, mondayStart[2].count)
        assertEquals(2, WidgetStats.maxBar(mondayStart))
        assertEquals(mondayStart[0], WidgetStats.peakBar(mondayStart))

        val sundayStart = WidgetStats.weekBars(addDays(monday, -1), 0, labels, events, monday, ::addDays)
        assertEquals("周日起始时第一天是周日", 0, sundayStart[0].count)
        assertEquals(2, sundayStart[1].count)
        assertEquals("周一仍是今天", 1, sundayStart.indexOfFirst { it.isToday })
        assertEquals(1, sundayStart[3].count)

        val empty = WidgetStats.weekBars(monday, 1, labels, emptyList(), monday, ::addDays)
        assertEquals(0, WidgetStats.maxBar(empty))
        assertNull("全 0 时没有峰值", WidgetStats.peakBar(empty))
    }

    @Test
    fun hoursPeakTakesEarliestWhenTied() {
        val day = at(2026, 10, 16, 0)
        val events = listOf(
            event(at(2026, 10, 16, 9), at(2026, 10, 16, 10)),
            event(at(2026, 10, 16, 14), at(2026, 10, 16, 15)),
            event(at(2026, 10, 16, 14, 30), at(2026, 10, 16, 15, 30)),
            event(at(2026, 10, 16, 20), at(2026, 10, 16, 21)),
            event(day, addDays(day, 1), allDay = true),
        )
        val hours = WidgetStats.hourCounts(events) { millis ->
            val cal = Calendar.getInstance()
            cal.timeInMillis = millis
            cal.get(Calendar.HOUR_OF_DAY)
        }
        assertEquals(1, hours[9])
        assertEquals(2, hours[14])
        assertEquals(1, hours[20])
        assertEquals("全天不计入时段", 0, hours[0])
        assertEquals(14, WidgetStats.peakHour(hours))
        assertEquals(4, WidgetStats.totalOf(hours))
        assertEquals(-1, WidgetStats.peakHour(IntArray(24)))
    }

    @Test
    fun catmullRomKeepsEndpointsAndSampleCount() {
        val points = listOf(0f to 0f, 1f to 2f, 2f to 1f, 3f to 3f)
        val curve = WidgetStats.catmullRom(points, samples = 12)
        // 0.4.1（总监单 m02062 裁决）：旧期望写成 4 × 12 = 48 是错的——把点数当成段数；
        // 4 点 = 3 段 × 12 采样 + 收尾那 1 点 = 37。依据 `design/widget-041/交付清单-0.4.1.md:38`
        // 「24 点 Catmull-Rom（每段 12 采样）」。实现不改。
        assertEquals("N 点 → (N−1) 段 × 12 + 1 = 37 个采样点", 37, curve.size)
        assertEquals(0f, curve.first().first, 0.0001f)
        assertEquals(0f, curve.first().second, 0.0001f)
        assertEquals(3f, curve.last().first, 0.0001f)
        assertEquals(3f, curve.last().second, 0.0001f)
        assertEquals(emptyList<Pair<Float, Float>>(), WidgetStats.catmullRom(emptyList()))
    }

    @Test
    fun firstCharHandlesEmojiAndBlank() {
        assertEquals("张", WidgetStats.firstChar("张伟"))
        assertEquals("📅", WidgetStats.firstChar("📅 日程"))
        assertEquals("", WidgetStats.firstChar(null))
        assertEquals("", WidgetStats.firstChar("   ").trim())
    }

    @Test
    fun agendaListUsesFixedTimeColumnAndAllDayLabel() {
        // 时间列固定 52dp：名称左缘 = pad + 色条 2.8 + 7 + 52 + 4，与文字长短无关。
        assertEquals(52f, WidgetStats.AGENDA_TIME_COL_DP, 0f)
        assertEquals("09:00–10:30", WidgetStats.agendaRangeLabel("09:00", "10:30"))
        assertEquals("全天文案不带破折号", "全天", WidgetStats.AGENDA_ALL_DAY)
        assertTrue("全天文案里不能出现破折号", !WidgetStats.AGENDA_ALL_DAY.contains("–"))
    }

    @Test
    fun agendaListNameColumnStartsAtTheSameXForEveryRow() {
        // 名称左缘是一条常量：12 + 7 + 52 + 4 = 75dp。行内文字长短不参与计算，
        // 所以「09:00–10:30」「全天」「一个很长的标题」三种行都从 75dp 开始。
        assertEquals(75f, WidgetStats.AGENDA_NAME_X_DP, 0.01f)
        assertEquals(
            "名称左缘 = 时间列右缘 + 4dp",
            WidgetStats.AGENDA_TIME_COL_RIGHT_DP + WidgetStats.AGENDA_NAME_GAP_DP,
            WidgetStats.AGENDA_NAME_X_DP,
            0f,
        )
        assertEquals("时间列右缘 = 12 + 7 + 52", 71f, WidgetStats.AGENDA_TIME_COL_RIGHT_DP, 0.01f)
        assertEquals(
            "名称左缘 - 时间列右缘 恒为 4dp，与文字无关",
            4f,
            WidgetStats.AGENDA_NAME_X_DP - WidgetStats.AGENDA_TIME_COL_RIGHT_DP,
            0f,
        )
    }

    @Test
    fun agendaListAllDayRowEndsAtTheTimeColumnRightEdge() {
        // 全天行「全天」右对齐到时间列右缘（71dp），不是居左留空；也不画破折号。
        assertFalse(WidgetStats.AGENDA_ALL_DAY.contains("–"))
        assertEquals("全天右缘 = 时间列右缘", 71f, WidgetStats.AGENDA_TIME_COL_RIGHT_DP, 0.01f)
        assertEquals(
            "「全天」右缘贴住时间列右缘，因此与名称左缘只差 4dp",
            4f,
            WidgetStats.AGENDA_NAME_X_DP - WidgetStats.AGENDA_TIME_COL_RIGHT_DP,
            0f,
        )
    }

    @Test
    fun agendaListCapacityFollowsAvailableHeight() {
        // top = pad 12 + 头部 12.5 + 间距 8 = 32.5；bottom = pad 12 + 底部 10 = 22。
        val top = 32.5f
        val bottom = 22f
        val row = WidgetStats.AGENDA_ROW_DP
        val label = WidgetStats.AGENDA_LABEL_DP
        val gap = WidgetStats.AGENDA_GROUP_GAP_DP

        // 148dp（4×2 真机高）：可用 148 - 32.5 - 22 - 2×(12+2) = 65.5 → 4 行。
        // 0.4.1（总监单 m02062 裁决）：旧期望写成 3 是错的——把每组「标签 12 + 组间距 2」误当成 16；
        // 依据 `design/widget-041/数值表-0.4.1.md:81`（4×2 / 4 列屏 148dp → 4 行）与
        // `design/widget-041/交付清单-0.4.1.md:45`（4×2 在 148dp 画满 4 条）。实现不改。
        val short = WidgetStats.agendaCapacity(148f, 2, row, label, gap, top, bottom)
        assertEquals(4, short)
        // 296dp（4×4 / 4 列屏）：可用 296 - 32.5 - 22 - 5×(12+2) = 171.5 → 10 行（数值表 :76）。
        val tall = WidgetStats.agendaCapacity(296f, 5, row, label, gap, top, bottom)
        assertEquals(10, tall)
        // 264dp（4×4 / 5 列屏）→ 8 行；250dp（4×4 / 最小）→ 7 行（数值表 :77-78，按高度画不凑数）。
        val fiveCol = WidgetStats.agendaCapacity(264f, 5, row, label, gap, top, bottom)
        assertEquals(8, fiveCol)
        val minWidth = WidgetStats.agendaCapacity(250f, 5, row, label, gap, top, bottom)
        assertEquals(7, minWidth)
        assertTrue("容量必须随高度变化，不能是常量", tall > short)

        // 组数越多，标签吃掉的高度越多；同高度下 5 组比 2 组能画的少。
        val two = WidgetStats.agendaCapacity(296f, 2, row, label, gap, top, bottom)
        assertTrue("组数增加会减少可画行数", two > tall)

        // 轮流分配：4 行 2 组 → 2 + 2；7 行 5 组 → 2 + 2 + 1 + 1 + 1。
        // 0.4.1（总监单 m02062）：本行原来也叫 `two`，与上面 `val two` 重名 → 整个测试类编译不过；
        // 只改变量名（断言一条未动），让 0.4.1 的 JVM 单测能在本机与 CI 跑起来。
        val pairRows = WidgetStats.agendaGroupRows(4, listOf(2, 2))
        assertEquals(2, pairRows[0])
        assertEquals(2, pairRows[1])
        val spread = WidgetStats.agendaGroupRows(7, listOf(3, 3, 3, 3, 3))
        assertEquals(7, spread.sum())
        assertEquals(2, spread[0])
        assertEquals(1, spread[4])
        assertTrue("每组都不超过该天条数", spread.indices.all { spread[it] <= 3 })
        assertEquals(0, WidgetStats.agendaGroupRows(0, listOf(2)).sum())
    }

    @Test
    fun agendaListDrawnPlusRemainingEqualsTotal() {
        // 真实总数 12（5 组），250dp 高度只画得下 7 行 → 画 7 + 还有 5 = 12。
        val capacity = WidgetStats.agendaCapacity(
            250f, 5, WidgetStats.AGENDA_ROW_DP, WidgetStats.AGENDA_LABEL_DP,
            WidgetStats.AGENDA_GROUP_GAP_DP, 32.5f, 22f,
        )
        assertEquals(7, capacity)
        val total = 12
        val rows = WidgetStats.agendaGroupRows(capacity, List(5) { 3 })
        val drawn = minOf(total, rows.sum())
        val remaining = total - drawn
        assertEquals("已画 + 还有 = 真实总数", total, drawn + remaining)
        assertEquals("250dp 装不下 12 条，还有条数必须由真实总数算", 5, remaining)
        assertTrue("还有条数不能是常量 0", remaining > 0)
    }

    @Test
    fun agendaListEndTimeIsLighterThanStartTime() {
        // 结束时间用 TEXT_3、开始时间用 TEXT_2：亮度必须更高（更浅）。
        assertTrue(
            "结束时间（TEXT_3）应比开始时间（TEXT_2）浅",
            WidgetTokens.relLum(WidgetTokens.TEXT_3) > WidgetTokens.relLum(WidgetTokens.TEXT_2),
        )
    }

    @Test
    fun dayCellEmojiComesFromMainCalendarFirstEvent() {
        val day = dayStart(at(2026, 10, 16, 12))
        val workA = event(
            at(2026, 10, 16, 9),
            at(2026, 10, 16, 10),
            calendarKey = "c1",
            calendarName = "工作",
            calendarColor = WidgetTokens.CALENDAR_PALETTE[0],
            tagEmoji = "💼",
        )
        val workB = event(
            at(2026, 10, 16, 11),
            at(2026, 10, 16, 12),
            calendarKey = "c1",
            calendarName = "工作",
            calendarColor = WidgetTokens.CALENDAR_PALETTE[0],
            tagEmoji = "📌",
        )
        val life = event(
            at(2026, 10, 16, 13),
            at(2026, 10, 16, 14),
            calendarKey = "c2",
            calendarName = "生活",
            calendarColor = WidgetTokens.CALENDAR_PALETTE[1],
            tagEmoji = "🏠",
        )
        val cell = WidgetStats.monthCells(day, 1, listOf(workA, workB, life), ::addDays).single()
        assertEquals(3, cell.count)
        assertEquals("颜色取当天条数最多的日历", WidgetTokens.CALENDAR_PALETTE[0], cell.colorArgb)
        assertEquals("emoji 取该日历当天第一条", "💼", cell.emoji)
        assertEquals("徽章最多 4 枚", 3, cell.badges.size)
    }
}
