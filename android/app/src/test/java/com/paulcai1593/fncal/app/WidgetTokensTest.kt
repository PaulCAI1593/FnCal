package com.paulcai1593.fncal.app

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * 0.4.1 颜色口径：主题墨色、热度四档、一周节奏四档、徽章实底/淡底、分组十色。
 *
 * 全是纯算术（`WidgetTokens` 不依赖 android.graphics），所以在本机 JVM 上就能跑，
 * 不必起模拟器；真机效果（抗锯齿、圆角）另由用户装 APK 验。
 */
class WidgetTokensTest {

    private val cardBg = 0xFFFFFFFF.toInt()
    private val inkBackdrop = 0xFFe8eef7.toInt()

    private fun hex(rgb: Int): String = String.format("#%06X", rgb and 0xFFFFFF)

    @Test
    fun accentInkMeetsContrastForEveryPreset() {
        // 六个预设逐个压深：亮度 ≤ 0.18，且对卡片上的浅底 ≥ 4.5:1（设计准入）。
        for (preset in WidgetTokens.ACCENT_PRESETS) {
            val ink = WidgetTokens.accentInk(preset)
            assertTrue("relLum(${hex(preset)} -> ${hex(ink)}) 应 ≤ 0.18", WidgetTokens.relLum(ink) <= 0.18)
            assertTrue(
                "contrast(${hex(preset)} -> ${hex(ink)}) 应 ≥ 4.5，实际 ${WidgetTokens.contrast(ink, inkBackdrop)}",
                WidgetTokens.contrast(ink, inkBackdrop) >= 4.5,
            )
            // 压深只会更暗或不变，不会变亮。
            assertTrue("压深不应变亮：${hex(preset)} -> ${hex(ink)}", WidgetTokens.relLum(ink) <= WidgetTokens.relLum(preset) + 1e-9)
        }
    }

    @Test
    fun curveGradientUsesThemeInkNotFixedBlue() {
        // 时段分析的渐变与描边都由主题墨色算；六种预设各算一次，RGB 必须等于该墨色。
        val fixedBlue = 0xFF2F5E9E.toInt()
        for (preset in WidgetTokens.ACCENT_PRESETS) {
            val ink = WidgetTokens.accentInk(preset)
            val from = WidgetTokens.withAlpha(ink, 0.30f)
            val to = WidgetTokens.withAlpha(ink, 0.02f)
            assertEquals("渐变起点 R", WidgetTokens.redOf(ink), WidgetTokens.redOf(from))
            assertEquals("渐变起点 G", WidgetTokens.greenOf(ink), WidgetTokens.greenOf(from))
            assertEquals("渐变起点 B", WidgetTokens.blueOf(ink), WidgetTokens.blueOf(from))
            assertEquals("渐变终点 B", WidgetTokens.blueOf(ink), WidgetTokens.blueOf(to))
            assertEquals("起点不透明度 0.30", 77, WidgetTokens.alphaOf(from))
            if (preset != fixedBlue) {
                assertNotEquals("不能写死蓝：${hex(preset)}", fixedBlue, from and 0xFFFFFF)
            }
        }
    }

    @Test
    fun heatLevelsAreFourStepsAndTopStepDarkens() {
        val base = WidgetTokens.CALENDAR_PALETTE[0]
        assertEquals(0, WidgetTokens.heatLevel(0))
        assertEquals(1, WidgetTokens.heatLevel(1))
        assertEquals(2, WidgetTokens.heatLevel(2))
        assertEquals(3, WidgetTokens.heatLevel(3))
        assertEquals(4, WidgetTokens.heatLevel(4))
        assertEquals(4, WidgetTokens.heatLevel(9))

        val empty = WidgetTokens.heatColor(base, 0)
        assertEquals("空格用 EMPTY_CELL", WidgetTokens.EMPTY_CELL, empty)

        val fills = (1..4).map { WidgetTokens.heatColor(base, it) }
        // 四档互不相同，且对空格的对比一档比一档高（透明度 0.42 / 0.58 / 0.76 / 1）。
        assertEquals(4, fills.toSet().size)
        val contrasts = fills.map { WidgetTokens.contrast(it, WidgetTokens.EMPTY_CELL) }
        for (index in 1 until contrasts.size) {
            assertTrue("第 ${index + 1} 档对比应高于前一档：$contrasts", contrasts[index] > contrasts[index - 1])
        }
        assertEquals("第 1 档 = 42% 叠白", WidgetTokens.tintWhite(base, 0.42f), fills[0])
        assertEquals("第 2 档 = 58% 叠白", WidgetTokens.tintWhite(base, 0.58f), fills[1])
        assertEquals("第 3 档 = 76% 叠白", WidgetTokens.tintWhite(base, 0.76f), fills[2])
        assertEquals("第 4 档 = 原色压深 12%", WidgetTokens.darken(base, 0.12f), fills[3])
    }

    @Test
    fun weekRhythmTiersUseFourAlphas() {
        assertEquals(0.92f, WidgetTokens.weekAlpha(1.0f), 0f)
        assertEquals(0.92f, WidgetTokens.weekAlpha(0.85f), 0f)
        assertEquals(0.72f, WidgetTokens.weekAlpha(0.84f), 0f)
        assertEquals(0.72f, WidgetTokens.weekAlpha(0.6f), 0f)
        assertEquals(0.5f, WidgetTokens.weekAlpha(0.59f), 0f)
        assertEquals(0.5f, WidgetTokens.weekAlpha(0.35f), 0f)
        assertEquals(0.32f, WidgetTokens.weekAlpha(0.34f), 0f)
        assertEquals(0.32f, WidgetTokens.weekAlpha(0f), 0f)
    }

    @Test
    fun badgeSolidUsesCalendarColorAndTimedUsesTranslucentFill() {
        val calendar = WidgetTokens.CALENDAR_PALETTE[0]
        val solid = WidgetTokens.badgeFill(calendar, solid = true)
        assertEquals("全天/多日徽章必须是日历色实底", calendar, solid)

        val timed = WidgetTokens.badgeFill(calendar, solid = false)
        assertEquals("定时徽章 = 日历色 30% 叠白", WidgetTokens.overWhite(calendar, 0.30f), timed)
        val timedContrast = WidgetTokens.contrast(timed, cardBg)
        assertTrue("定时徽章应明显淡于实底（对白底 < 1.5:1），实际 $timedContrast", timedContrast < 1.5)
        assertTrue(
            "实底对白底应明显更深，实际 ${WidgetTokens.contrast(solid, cardBg)}",
            WidgetTokens.contrast(solid, cardBg) > timedContrast,
        )
        assertEquals("淡底细边 = 同色 50% 叠白", WidgetTokens.overWhite(calendar, 0.50f), WidgetTokens.badgeRing(calendar))
    }

    @Test
    fun badgeGeometryIsElevenPointTwoWithTwoPointEightGap() {
        assertEquals(11.2f, WidgetTokens.BADGE_DIAMETER_DP, 0f)
        assertEquals(2.8f, WidgetTokens.BADGE_GAP_DP, 0f)
        assertEquals("emoji = 直径 × 0.62", 6.944f, WidgetStats.badgeEmojiSize(), 0.0005f)

        val offsets = WidgetStats.badgeOffsets(4)
        assertEquals(4, offsets.size)
        // 每行两个、水平居中对称：x = ±(直径 + 间距) / 2 = ±7.0dp。
        assertEquals(-7.0f, offsets[0].first, 0.0005f)
        assertEquals(7.0f, offsets[1].first, 0.0005f)
        assertEquals(-7.0f, offsets[2].first, 0.0005f)
        assertEquals(7.0f, offsets[3].first, 0.0005f)
        // 行距 = 直径 + 间距 = 14dp，最多两行。
        assertEquals(0f, offsets[0].second, 0.0005f)
        assertEquals(0f, offsets[1].second, 0.0005f)
        assertEquals(14.0f, offsets[2].second, 0.0005f)
        assertEquals(14.0f, offsets[3].second, 0.0005f)
        assertEquals("最多 4 枚（每行 2 × 最多 2 行）", 4, WidgetStats.badgeOffsets(8).size)
    }

    @Test
    fun groupPaletteIsTenColorsAndUngroupedIsNeutral() {
        assertEquals(10, WidgetTokens.GROUP_PALETTE.size)
        assertEquals(WidgetTokens.GROUP_PALETTE[0], WidgetTokens.groupColorAt(0))
        assertEquals(WidgetTokens.GROUP_PALETTE[9], WidgetTokens.groupColorAt(9))
        assertEquals("下标越界回绕", WidgetTokens.GROUP_PALETTE[0], WidgetTokens.groupColorAt(10))
        assertEquals("未分组用中性灰棕", WidgetTokens.UNGROUPED, WidgetTokens.groupColorAt(-1))
        assertEquals("1 起的分组顺序仍可用", WidgetTokens.GROUP_PALETTE[1], WidgetTokens.groupColor(2))
    }
}
