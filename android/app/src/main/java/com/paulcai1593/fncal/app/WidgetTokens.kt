package com.paulcai1593.fncal.app

import kotlin.math.pow
import kotlin.math.roundToInt

/**
 * 0.4.1 桌面卡片的颜色与颜色运算（纯 Kotlin，不引用 android.graphics）。
 *
 * 数值来源：`projects/FnCal/design/widget-design/gen-widgets.mjs`（设计定稿，0.4.1）。
 * 这里必须与设计渲染器逐项一致，且统计口径与网页年度总结同源：
 *   - 日历九色 = 网页日历默认九色；
 *   - 分组十色 = `projects/FnCal/code/shared/annual-review.mjs` 的 `GROUP_PALETTE`；
 *   - 四档透明度与「第 4 档再压深 12%」= 年度总结日热度的 `[0,.56,.78,1,1]` 观感换算到卡片上的口径。
 *
 * 颜色一律是 Android 的 ARGB Int（`0xAARRGGBB`）。
 */
object WidgetTokens {

    /* ---- 设计稿的中性色（gen-widgets.mjs 顶部常量） ---- */
    const val WHITE = 0xFFFFFFFF.toInt()
    const val BLACK = 0xFF000000.toInt()
    const val TEXT = 0xFF14161C.toInt()
    const val TEXT_2 = 0xFF4B5162.toInt()
    const val TEXT_3 = 0xFF5F6675.toInt()
    const val BORDER = 0xFFE2E5EB.toInt()
    const val CARD_BG = 0xFFFFFFFF.toInt()

    /** 热力图/一周节奏里的「空格」底色。 */
    const val EMPTY_CELL = 0xFFD6E1ED.toInt()

    /** 未分组（与年度总结 `UNGROUPED_COLOR` 一致）。 */
    const val UNGROUPED = 0xFF6b5f52.toInt()

    /** 「其他」分组（与年度总结 `OTHER_COLOR` 一致）。 */
    const val OTHER = 0xFF98a2b3.toInt()

    /** 分类条底槽、四日浅底、今日块等辅色。 */
    const val TRACK = 0xFFF1F4F9.toInt()
    const val SOFT_DAY = 0xFFF2F6FD.toInt()
    const val SOFT_DAY_2 = 0xFFF7F9FC.toInt()
    const val DIVIDER = 0xFFEDF0F5.toInt()
    const val ZERO_BAR = 0xFFE7ECF4.toInt()

    /** 日历默认九色（网页与年度总结同源）。 */
    val CALENDAR_PALETTE: IntArray = intArrayOf(
        0xFF3171e0.toInt(),
        0xFF5b5ef4.toInt(),
        0xFF9355dc.toInt(),
        0xFFd52f85.toInt(),
        0xFFd73b3c.toInt(),
        0xFFf59e0b.toInt(),
        0xFF088657.toInt(),
        0xFF078477.toInt(),
        0xFF6b7280.toInt(),
    )

    /** 分组十色（`GROUP_PALETTE`，按 groupOrder 1..10 循环）。 */
    val GROUP_PALETTE: IntArray = intArrayOf(
        0xFFda7f92.toInt(),
        0xFF5ab669.toInt(),
        0xFF59b8dd.toInt(),
        0xFFbf9759.toInt(),
        0xFFa890d4.toInt(),
        0xFFf28a6e.toInt(),
        0xFF60bead.toInt(),
        0xFFb4b135.toInt(),
        0xFF6da0e6.toInt(),
        0xFFda8dc8.toInt(),
    )

    /** 六种主题预设（与网页设置一致），单测用它逐项核对 `accentInk`。 */
    val ACCENT_PRESETS: IntArray = intArrayOf(
        0xFF2f5e9e.toInt(),
        0xFF1f9e8f.toInt(),
        0xFF6b4fa8.toInt(),
        0xFFc26a1f.toInt(),
        0xFFb3392f.toInt(),
        0xFF4b5162.toInt(),
    )

    /** 年度总结的日热度四档透明度（第 1..4 档）。 */
    private const val HEAT_ALPHA_1 = 0.42f
    private const val HEAT_ALPHA_2 = 0.58f
    private const val HEAT_ALPHA_3 = 0.76f
    private const val HEAT_ALPHA_4 = 1.0f

    /** 一周节奏四档混白透明度（第 1..4 档）。 */
    private const val WEEK_ALPHA_1 = 0.32f
    private const val WEEK_ALPHA_2 = 0.5f
    private const val WEEK_ALPHA_3 = 0.72f
    private const val WEEK_ALPHA_4 = 0.92f

    /* ---- 颜色运算 ---- */

    fun alphaOf(argb: Int): Int = (argb ushr 24) and 0xFF

    fun redOf(argb: Int): Int = (argb ushr 16) and 0xFF

    fun greenOf(argb: Int): Int = (argb ushr 8) and 0xFF

    fun blueOf(argb: Int): Int = argb and 0xFF

    fun argb(alpha: Int, r: Int, g: Int, b: Int): Int =
        ((alpha and 0xFF) shl 24) or ((r and 0xFF) shl 16) or ((g and 0xFF) shl 8) or (b and 0xFF)

    /** 按比例把 alpha 换成新值（保留 RGB）。 */
    fun withAlpha(color: Int, alpha: Float): Int =
        argb((alpha.coerceIn(0f, 1f) * 255f).roundToInt(), redOf(color), greenOf(color), blueOf(color))

    /** `mixHex(a, b, t)`：t=0 得 a，t=1 得 b，逐通道四舍五入。 */
    fun mix(a: Int, b: Int, t: Float): Int {
        val k = t.coerceIn(0f, 1f)
        fun channel(x: Int, y: Int): Int = (x + (y - x) * k).roundToInt().coerceIn(0, 255)
        return argb(
            channel(alphaOf(a), alphaOf(b)),
            channel(redOf(a), redOf(b)),
            channel(greenOf(a), greenOf(b)),
            channel(blueOf(a), blueOf(b)),
        )
    }

    /** `tintWhite(color, alpha)`：alpha 越大概率越接近纯色（叠在白卡上的观感）。 */
    fun tintWhite(color: Int, alpha: Float): Int = mix(WHITE, color, alpha)

    /**
     * `overWhite(color, opacity)`：颜色按不透明度叠在白卡上。
     * 与 `tintWhite` 的区别：`opacity=1` 仍是纯色，`opacity=0.30` 是「30% 半透明」。
     * 大月历「定时日程」的淡底徽章用它（设计稿 `mixHex('#FFFFFF', color, 0.30)`）。
     */
    fun overWhite(color: Int, opacity: Float): Int = mix(WHITE, color, opacity)

    /** `darkenHex(color, amount)`：逐通道乘 (1 - amount)。 */
    fun darken(color: Int, amount: Float): Int = mix(color, BLACK, amount)

    /** sRGB 相对亮度（WCAG）。 */
    fun relLum(color: Int): Double {
        fun lin(v: Int): Double {
            val s = v / 255.0
            return if (s <= 0.03928) s / 12.92 else ((s + 0.055) / 1.055).pow(2.4)
        }
        return 0.2126 * lin(redOf(color)) + 0.7152 * lin(greenOf(color)) + 0.0722 * lin(blueOf(color))
    }

    /** WCAG 对比度。 */
    fun contrast(a: Int, b: Int): Double {
        val la = relLum(a)
        val lb = relLum(b)
        val hi = if (la > lb) la else lb
        val lo = if (la > lb) lb else la
        return (hi + 0.05) / (lo + 0.05)
    }

    /**
     * 主题色墨色：设计稿 `accentInk()` 的 Kotlin 版。
     * 逐次压深 12%，直到亮度 ≤ 0.18 且对卡面 `#e8eef7` 的对比度 ≥ 4.5；最多 20 次。
     */
    fun accentInk(value: Int): Int {
        var hex = value or 0xFF000000.toInt()
        var guard = 0
        while ((relLum(hex) > 0.18 || contrast(hex, 0xFFe8eef7.toInt()) < 4.5) && guard < 20) {
            hex = darken(hex, 0.12f)
            guard += 1
        }
        return hex
    }

    /* ---- 四档（热度 / 一周节奏） ---- */

    /** 当天条数 → 热度档 0（无）…4（4 条以上）。 */
    fun heatLevel(count: Int): Int = when {
        count <= 0 -> 0
        count == 1 -> 1
        count == 2 -> 2
        count == 3 -> 3
        else -> 4
    }

    /** 当天条数 → 热度格颜色：空格底色、前 3 档混白、第 4 档再压深 12%。 */
    fun heatColor(base: Int, count: Int): Int {
        val level = heatLevel(count)
        if (level == 0) return EMPTY_CELL
        val alpha = when (level) {
            1 -> HEAT_ALPHA_1
            2 -> HEAT_ALPHA_2
            3 -> HEAT_ALPHA_3
            else -> HEAT_ALPHA_4
        }
        val fill = tintWhite(base, alpha)
        return if (level == 4) darken(fill, 0.12f) else fill
    }

    /** 一周节奏：`v / mx` 的比值 → 第 1..4 档混白透明度。 */
    fun weekAlpha(ratio: Float): Float = when {
        ratio >= 0.85f -> WEEK_ALPHA_4
        ratio >= 0.6f -> WEEK_ALPHA_3
        ratio >= 0.35f -> WEEK_ALPHA_2
        else -> WEEK_ALPHA_1
    }

    /** 一周节奏柱色：主题墨色四档混白。 */
    fun weekColor(ink: Int, ratio: Float): Int = tintWhite(ink, weekAlpha(ratio))

    /** 分组色：order 从 1 起，<=0 或非整数视为未分组（与年度总结一致）。 */
    fun groupColor(order: Int): Int {
        if (order < 1) return UNGROUPED
        return GROUP_PALETTE[(order - 1) % GROUP_PALETTE.size]
    }

    /**
     * 分组色（0 起下标）：接口 `tagGroupIndex` 就是设置里的分组顺序、从 0 开始，
     * 与年度总结的十色板、取色顺序一致；-1 表示未分组。
     */
    fun groupColorAt(index: Int): Int {
        if (index < 0) return UNGROUPED
        return GROUP_PALETTE[index % GROUP_PALETTE.size]
    }

    /* ---- 大月历徽章（0.4.1 补：全天/多日实底、定时淡底 + 细边） ---- */

    /** 徽章直径 11.2dp、行内间距 2.8dp（设计定稿）。 */
    const val BADGE_DIAMETER_DP = 11.2f
    const val BADGE_GAP_DP = 2.8f

    /** 徽章填充：全天 / 多日 = 日历色实底；定时 = 日历色 30% 叠白。 */
    fun badgeFill(calendarColor: Int, solid: Boolean): Int =
        if (solid) calendarColor else overWhite(calendarColor, 0.30f)

    /** 淡底徽章的细边：同色 50% 叠白、0.7dp，保证 11.2dp 圆在白卡上有边界。 */
    fun badgeRing(calendarColor: Int): Int = overWhite(calendarColor, 0.50f)

    /** 日历色兜底：按 id 的哈希挑一个九色，保证同一日历颜色稳定。 */
    fun calendarFallbackColor(id: String?): Int {
        val key = id ?: ""
        if (key.isEmpty()) return CALENDAR_PALETTE[0]
        var hash = 0
        for (ch in key) hash = (hash * 31 + ch.code) and 0x7FFFFFFF
        return CALENDAR_PALETTE[hash % CALENDAR_PALETTE.size]
    }
}
