package com.paulcai1593.fncal.app

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Test

/**
 * 0.4.1 桌卡「有字段 / 无字段」双分支自检。
 *
 * 背景：服务端 0.8.29 起在日程里多给四个字段（`tagEmoji`、`tagGroupId`、`tagGroupName`、
 * `tagGroupIndex`）。客户端必须两路都正确：
 *   - 有字段：分类名用 `tagGroupName`、emoji 用 `tagEmoji`、颜色用分组十色（`tagGroupIndex`）；
 *   - 无字段（老服务端 / 未打标签 / 字段为空）：整条退回日历名、日历名首字、日历色。
 *
 * 这一层是纯 Kotlin（不引 android.graphics），所以可用普通 JUnit 在 JVM 上直接跑，
 * 不必起模拟器、也不进 APK。
 *
 * 对应源码：`WidgetStats.kt:101-143`（`StatEvent.categoryName / categoryEmoji / categoryColor`）、
 * `WidgetStats.kt:264-296`（`categories()` 的聚合与排序）、`WidgetTokens.kt:57-66`（十色板）、
 * `WidgetTokens.kt:213-216`（`groupColorAt`）。
 */
class WidgetTagFieldsTest {

    private val calendarColor = 0xFF3171E0.toInt()
    private val otherCalendarColor = 0xFFD52F85.toInt()

    private fun event(
        name: String = "工作日历",
        color: Int = calendarColor,
        tagEmoji: String? = null,
        tagGroupName: String? = null,
        tagGroupIndex: Int = -1,
        allDay: Boolean = false,
        start: Long = 1_700_000_000_000L,
        end: Long = 1_700_003_600_000L,
    ) = WidgetStats.StatEvent(
        start = start,
        end = end,
        allDay = allDay,
        calendarKey = name,
        calendarName = name,
        calendarColor = color,
        tagEmoji = tagEmoji,
        tagGroupName = tagGroupName,
        tagGroupIndex = tagGroupIndex,
    )

    /* ---------------- 分支一：有字段 ---------------- */

    @Test
    fun `有字段-分类名取分组名而不是日历名`() {
        val e = event(name = "个人", tagEmoji = "💼", tagGroupName = "工作", tagGroupIndex = 0)
        assertEquals("有 tagGroupName 时分类名应是分组名", "工作", e.categoryName)
    }

    @Test
    fun `有字段-emoji 取接口给的 tagEmoji`() {
        val e = event(tagEmoji = "💼", tagGroupName = "工作", tagGroupIndex = 0)
        assertEquals("tagEmoji 优先于分组名首字", "💼", e.categoryEmoji())
    }

    @Test
    fun `有字段-tagEmoji 两侧空白要去掉`() {
        val e = event(tagEmoji = "  💼  ", tagGroupName = "工作", tagGroupIndex = 0)
        assertEquals("tagEmoji 应 trim", "💼", e.categoryEmoji())
    }

    @Test
    fun `有字段-颜色取分组十色按下标`() {
        val first = event(tagGroupName = "工作", tagGroupIndex = 0)
        assertEquals("下标 0 = 十色板第 1 色", WidgetTokens.GROUP_PALETTE[0], first.categoryColor())
        val tenth = event(tagGroupName = "第十组", tagGroupIndex = 9)
        assertEquals("下标 9 = 十色板第 10 色", WidgetTokens.GROUP_PALETTE[9], tenth.categoryColor())
        assertNotEquals("有分组时不再用日历色", calendarColor, first.categoryColor())
    }

    @Test
    fun `有字段-下标超过 9 按十色板循环`() {
        val e = event(tagGroupName = "第十一组", tagGroupIndex = 10)
        assertEquals("groupColorAt 取模十色板", WidgetTokens.GROUP_PALETTE[0], e.categoryColor())
    }

    @Test
    fun `有字段-分类行带出分组名 emoji 颜色与分组顺序`() {
        val rows = WidgetStats.categories(
            listOf(
                event(tagEmoji = "💼", tagGroupName = "工作", tagGroupIndex = 2),
                event(tagEmoji = "🏃", tagGroupName = "运动", tagGroupIndex = 0),
                event(tagEmoji = "💼", tagGroupName = "工作", tagGroupIndex = 2),
            )
        )
        assertEquals("两条工作一条运动 → 2 行", 2, rows.size)
        assertEquals("第一条按条数降序是工作", "工作", rows[0].name)
        assertEquals("分类行 emoji 用 tagEmoji", "💼", rows[0].emoji)
        assertEquals("分类行颜色用分组下标", WidgetTokens.GROUP_PALETTE[2], rows[0].colorArgb)
        assertEquals("分类行带出分组顺序", 2, rows[0].groupOrder)
        assertEquals("第二条是运动", "运动", rows[1].name)
    }

    @Test
    fun `有字段-分组名首字支持代理对`() {
        val e = event(tagGroupName = "𝄞音乐", tagGroupIndex = 1)
        assertEquals("没有 tagEmoji 时取分组名首字（代理对整取）", "𝄞", e.categoryEmoji())
    }

    /* ---------------- 分支二：无字段（含空值） ---------------- */

    @Test
    fun `无字段-三项全部退回日历`() {
        val e = event(name = "工作日历", color = otherCalendarColor)
        assertEquals("无字段时分类名 = 日历名", "工作日历", e.categoryName)
        assertEquals("无字段时 emoji = 日历名首字", "工", e.categoryEmoji())
        assertEquals("无字段时颜色 = 日历色", otherCalendarColor, e.categoryColor())
    }

    @Test
    fun `无字段-只有分组名时用未分组色`() {
        val e = event(name = "个人", color = calendarColor, tagGroupName = "工作")
        assertEquals("有分组名 → 分类名用分组名", "工作", e.categoryName)
        assertEquals("无 tagEmoji → 分组名首字", "工", e.categoryEmoji())
        assertEquals("有分组名但没有下标 → 未分组色", WidgetTokens.UNGROUPED, e.categoryColor())
    }

    @Test
    fun `无字段-只有 tagEmoji 时其余仍降级`() {
        val e = event(name = "家庭", color = otherCalendarColor, tagEmoji = "🏠")
        assertEquals("没有分组名 → 分类名 = 日历名", "家庭", e.categoryName)
        assertEquals("emoji 用 tagEmoji", "🏠", e.categoryEmoji())
        assertEquals("没有分组下标 → 日历色", otherCalendarColor, e.categoryColor())
    }

    @Test
    fun `无字段-只有下标时名称与 emoji 仍降级`() {
        val e = event(name = "个人", color = calendarColor, tagGroupIndex = 3)
        assertEquals("没有分组名 → 分类名 = 日历名", "个人", e.categoryName)
        assertEquals("没有 tagEmoji 与分组名 → 日历名首字", "个", e.categoryEmoji())
        assertEquals("下标 ≥ 0 → 十色板第 4 色", WidgetTokens.GROUP_PALETTE[3], e.categoryColor())
    }

    @Test
    fun `无字段-空白字符串当作没有`() {
        val e = event(name = "备忘", color = calendarColor, tagEmoji = "   ", tagGroupName = "   ")
        assertEquals("空白分组名不算分组 → 日历名", "备忘", e.categoryName)
        assertEquals("空白 tagEmoji → 日历名首字", "备", e.categoryEmoji())
        assertEquals("空白分组名 → 日历色", calendarColor, e.categoryColor())
    }

    @Test
    fun `无字段-分类行按日历名聚合`() {
        val rows = WidgetStats.categories(
            listOf(
                event(name = "工作日历"),
                event(name = "工作日历"),
                event(name = "家庭", color = otherCalendarColor),
            )
        )
        assertEquals("无字段时按日历名聚合 → 2 行", 2, rows.size)
        assertEquals("工作日历 2 条在前", "工作日历", rows[0].name)
        assertEquals("分类行 emoji 用日历名首字", "工", rows[0].emoji)
        assertEquals("分类行颜色用日历色", calendarColor, rows[0].colorArgb)
        assertEquals("无分组下标 → groupOrder = -1", -1, rows[0].groupOrder)
    }

    @Test
    fun `无字段-同条数时有分组的排在前面`() {
        val rows = WidgetStats.categories(
            listOf(
                event(name = "个人", color = calendarColor),
                event(name = "工作", color = otherCalendarColor, tagGroupName = "工作", tagGroupIndex = 5),
            )
        )
        assertEquals("同 1 条：有分组在前", "工作", rows[0].name)
        assertEquals("后排是无分组的那行", "个人", rows[1].name)
    }
}
