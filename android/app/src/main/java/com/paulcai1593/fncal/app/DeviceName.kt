package com.paulcai1593.fncal.app

import android.os.Build

/**
 * 0.3.0 §D：设备机型标签，供两个 UA 共用：
 *   - 壳内 WebView：`FnCalAndroid/0.3.7 (<MANUFACTURER> <MODEL>)`
 *   - 卡片取数：  `FnCalWidget/0.3.7 (<MANUFACTURER> <MODEL>)`
 *
 * 规则：去首尾空格、连续空格压成一个、最长 40 字符（按字符而不是字节截断，
 * 非 ASCII 机型名保留），空值不写入括号。
 */
object DeviceName {

    private const val MAX_LENGTH = 40

    fun model(): String {
        val raw = "${Build.MANUFACTURER.orEmpty()} ${Build.MODEL.orEmpty()}"
        val collapsed = raw.replace(Regex("\\s+"), " ").trim()
        if (collapsed.isEmpty()) return ""
        return if (collapsed.length <= MAX_LENGTH) collapsed else collapsed.substring(0, MAX_LENGTH).trim()
    }

    /** `Xiaomi 13` → ` (Xiaomi 13)`；没有机型信息时返回空串，不输出空括号。 */
    fun suffix(): String {
        val model = model()
        return if (model.isEmpty()) "" else " ($model)"
    }
}
