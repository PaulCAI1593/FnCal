package com.paulcai1593.fncal.app

import android.graphics.Color
import org.json.JSONArray
import org.json.JSONObject
import java.text.SimpleDateFormat
import java.util.Calendar
import java.util.Date
import java.util.HashMap
import java.util.Locale
import java.util.TimeZone

/** 一条来自 `/api/widget/v1/summary` 的日程（字段与 0.6.0 接口白名单一致）。 */
data class WidgetEvent(
    val id: String,
    val summary: String,
    val start: Long,
    val end: Long,
    val allDay: Boolean,
    val color: Int?,
    val location: String?,
)

/**
 * 一次摘要结果。只保留画卡片需要的字段；解析失败返回 null（卡片退回缓存/设置提示）。
 */
data class WidgetSnapshot(
    val generatedAt: Long,
    val fromDate: String?,
    val toDate: String?,
    val events: List<WidgetEvent>,
    /** 0.3.4 §8：0 = 周日为一周之始，1 = 周一。由网页设置 `cal:settings` 带来。 */
    val weekStartsOn: Int = 0,
) {
    /**
     * 与某一天相交的事件：`start < dayEnd && end > dayStart`。
     * 全天事件排在最前，其余按开始时间。
     */
    fun eventsOn(dayStart: Long, dayEnd: Long): List<WidgetEvent> =
        events.filter { it.start < dayEnd && it.end > dayStart }
            .sortedWith(compareByDescending<WidgetEvent> { it.allDay }.thenBy { it.start })

    companion object {
        /**
         * 0.6.0 接口回的是 `{ok, version, generatedAt, timeZone, from, to, privacy, calendars, events, truncated?}`；
         * 这里只认 events/from/to/generatedAt。逐条容错：坏事件跳过，不让整张卡片变空。
         */
        fun parse(raw: String?, weekStartsOn: Int = 0): WidgetSnapshot? {
            if (raw.isNullOrBlank()) return null
            return try {
                val root = JSONObject(raw)
                val colors = HashMap<String, Int>()
                val calendarArray = root.optJSONArray("calendars")
                if (calendarArray != null) {
                    for (i in 0 until calendarArray.length()) {
                        val cal = calendarArray.optJSONObject(i) ?: continue
                        val id = cal.optString("id", "")
                        val color = colorOf(cal.optString("color", ""))
                        if (id.isNotEmpty() && color != null) colors[id] = color
                    }
                }
                val events = ArrayList<WidgetEvent>()
                val eventArray: JSONArray = root.optJSONArray("events") ?: JSONArray()
                for (i in 0 until eventArray.length()) {
                    val item = eventArray.optJSONObject(i) ?: continue
                    val start = IsoTime.parse(item.optString("start", "")) ?: continue
                    val end = IsoTime.parse(item.optString("end", "")) ?: start
                    val summary = item.optString("summary", "")
                    val calendarId = item.optString("calendarId", "")
                    val color = colorOf(item.optString("color", "")) ?: colors[calendarId]
                    events.add(
                        WidgetEvent(
                            id = item.optString("id", ""),
                            summary = summary.ifBlank { "" },
                            start = start,
                            end = if (end > start) end else start + 1,
                            allDay = item.optBoolean("allDay", false),
                            color = color,
                            location = item.optString("location", "").ifBlank { null },
                        )
                    )
                }
                WidgetSnapshot(
                    generatedAt = IsoTime.parse(root.optString("generatedAt", "")) ?: 0L,
                    fromDate = root.optString("from", "").ifBlank { null },
                    toDate = root.optString("to", "").ifBlank { null },
                    events = events,
                    weekStartsOn = normalizedWeekStart(weekStartsOn),
                )
            } catch (e: Exception) {
                null
            }
        }

        /** `#RRGGBB` / `#AARRGGBB`；非法值返回 null，由调用方退回强调色。 */
        fun colorOf(value: String?): Int? {
            if (value.isNullOrBlank() || !value.startsWith("#")) return null
            return try {
                Color.parseColor(value)
            } catch (e: IllegalArgumentException) {
                null
            }
        }
    }
}

/** ISO 时间解析。服务端给的是带偏移的 ISO（如 `2026-11-07T09:00:00.000+08:00`）。 */
object IsoTime {

    private val WITH_MILLIS = arrayOf(
        "yyyy-MM-dd'T'HH:mm:ss.SSSXXX",
        "yyyy-MM-dd'T'HH:mm:ss.SSSXX",
        "yyyy-MM-dd'T'HH:mm:ss.SSSZ",
    )
    private val WITH_SECONDS = arrayOf(
        "yyyy-MM-dd'T'HH:mm:ssXXX",
        "yyyy-MM-dd'T'HH:mm:ssXX",
        "yyyy-MM-dd'T'HH:mm:ss'Z'",
    )

    fun parse(value: String?): Long? {
        if (value.isNullOrBlank()) return null
        val text = value.trim()
        if (text.length <= 10) {
            // 全天事件：`YYYY-MM-DD`，按本地午夜解释。
            return parseWith("yyyy-MM-dd", text, TimeZone.getDefault())
        }
        for (pattern in WITH_MILLIS + WITH_SECONDS) {
            val parsed = parseWith(pattern, text, TimeZone.getTimeZone("UTC"))
            if (parsed != null) return parsed
        }
        // 不带偏移的兜底：按本地时间。
        for (pattern in arrayOf("yyyy-MM-dd'T'HH:mm:ss.SSS", "yyyy-MM-dd'T'HH:mm:ss")) {
            val parsed = parseWith(pattern, text, TimeZone.getDefault())
            if (parsed != null) return parsed
        }
        return null
    }

    private fun parseWith(pattern: String, text: String, zone: TimeZone): Long? = try {
        val format = SimpleDateFormat(pattern, Locale.US)
        format.isLenient = false
        format.timeZone = zone
        val date: Date? = format.parse(text)
        date?.time
    } catch (e: Exception) {
        null
    }
}

/** 卡片里用到的一点日期/时间计算，全部走 Calendar，避免 minSdk 24 上没有 java.time。 */
object CalKit {

    private const val DAY_MS = 86_400_000L

    fun dayStart(millis: Long): Long = Calendar.getInstance().apply {
        timeInMillis = millis
        set(Calendar.HOUR_OF_DAY, 0)
        set(Calendar.MINUTE, 0)
        set(Calendar.SECOND, 0)
        set(Calendar.MILLISECOND, 0)
    }.timeInMillis

    fun dayEnd(millis: Long): Long = dayStart(millis) + DAY_MS

    fun addDays(millis: Long, days: Int): Long = Calendar.getInstance().apply {
        timeInMillis = millis
        add(Calendar.DAY_OF_MONTH, days)
    }.timeInMillis

    fun monthStart(millis: Long): Long = Calendar.getInstance().apply {
        timeInMillis = millis
        set(Calendar.DAY_OF_MONTH, 1)
        set(Calendar.HOUR_OF_DAY, 0)
        set(Calendar.MINUTE, 0)
        set(Calendar.SECOND, 0)
        set(Calendar.MILLISECOND, 0)
    }.timeInMillis

    fun addMonths(millis: Long, months: Int): Long = Calendar.getInstance().apply {
        timeInMillis = millis
        add(Calendar.MONTH, months)
    }.timeInMillis

    fun daysInMonth(millis: Long): Int = Calendar.getInstance().apply {
        timeInMillis = millis
    }.getActualMaximum(Calendar.DAY_OF_MONTH)

    /**
     * 0.3.4 §8：一周里的第几天，0 = 该周第一天。
     * `weekStartsOn` 0 = 周日（Calendar 的 DAY_OF_WEEK 原序）、1 = 周一。
     */
    fun weekdayIndex(millis: Long, weekStartsOn: Int): Int = Calendar.getInstance().apply {
        timeInMillis = millis
    }.let { cal ->
        ((cal.get(Calendar.DAY_OF_WEEK) - 1 - normalizedWeekStart(weekStartsOn)) + 7) % 7
    }

    /** 只接受 0 / 1，其它值按 0（周日）处理，与网页设置的缺省一致。 */
    fun normalizedWeekStart(value: Int): Int = if (value == 1) 1 else 0

    /** 表头：周一为首 → 一…日；周日为首 → 日一二三四五六。 */
    fun weekLabels(weekStartsOn: Int): Array<String> =
        if (normalizedWeekStart(weekStartsOn) == 1) {
            arrayOf("一", "二", "三", "四", "五", "六", "日")
        } else {
            arrayOf("日", "一", "二", "三", "四", "五", "六")
        }

    fun hourOf(millis: Long): Int = Calendar.getInstance().apply { timeInMillis = millis }
        .get(Calendar.HOUR_OF_DAY)

    fun minuteOf(millis: Long): Int = Calendar.getInstance().apply { timeInMillis = millis }
        .get(Calendar.MINUTE)

    fun dayOfMonth(millis: Long): Int = Calendar.getInstance().apply { timeInMillis = millis }
        .get(Calendar.DAY_OF_MONTH)

    fun isSameDay(a: Long, b: Long): Boolean = dayStart(a) == dayStart(b)

    fun isoDate(millis: Long): String = SimpleDateFormat("yyyy-MM-dd", Locale.US)
        .format(Date(millis))

    fun hhmm(millis: Long): String = SimpleDateFormat("HH:mm", Locale.US).format(Date(millis))

    /** `2026年11月` */
    fun monthTitle(millis: Long): String = SimpleDateFormat("yyyy年M月", Locale.US)
        .format(Date(millis))

    /** `11月7日` */
    fun dayMonth(millis: Long): String = SimpleDateFormat("M月d日", Locale.US)
        .format(Date(millis))

    /** `周五`（周一为一周之始的语境里仍然按星期几读）。 */
    fun weekdayShort(millis: Long): String {
        val labels = arrayOf("周日", "周一", "周二", "周三", "周四", "周五", "周六")
        val index = Calendar.getInstance().apply { timeInMillis = millis }
            .get(Calendar.DAY_OF_WEEK) - 1
        return labels[index.coerceIn(0, 6)]
    }

    fun monthGridStart(monthMillis: Long, weekStartsOn: Int = 0): Long {
        val first = monthStart(monthMillis)
        return addDays(first, -weekdayIndex(first, weekStartsOn))
    }
}
