package com.paulcai1593.fncal.app

import android.app.Activity
import android.graphics.RenderEffect
import android.graphics.Shader
import android.os.Build
import android.view.View
import androidx.annotation.RequiresApi
import androidx.core.content.ContextCompat
import androidx.core.view.WindowInsetsControllerCompat

/**
 * 0.2.0：地址页 / 关于页的深色蓝绿渐变 + 毛玻璃表面。
 *
 * 两层职责：
 * 1. [applyWindow] 把状态栏与导航栏染成渐变起点色，并把系统图标切成浅色。
 * 2. [installBlurLayer] 给布局里的 `blur_layer`（两个径向光斑）加模糊：
 *    - API 31+（Android 12）用 `RenderEffect` 真模糊；
 *    - API 24–30 没有 View 级模糊，降级为「多层半透明 + 光斑」——只把这一层
 *      的 alpha 降到 0.55，让光斑与卡片叠加出磨砂观感，不崩、不黑块。
 *
 * 该主题固定深色，不跟随系统浅色/深色（范围文档 §B1）。
 */
object GlassSurface {

    /** 真模糊半径；28dp 时 390dp 宽屏上接近 CSS blur(18px) 的观感。 */
    private const val BLUR_RADIUS_DP = 28f

    /** API 24–30 的降级透明度：光斑淡一些，避免比卡片更抢眼。 */
    private const val FALLBACK_LAYER_ALPHA = 0.55f

    fun applyWindow(activity: Activity) {
        val window = activity.window
        val barColor = ContextCompat.getColor(activity, R.color.bg_grad_start)
        // 状态栏 / 导航栏同色；API 35 起这两个 setter 会被忽略，但不会崩。
        @Suppress("DEPRECATION")
        window.statusBarColor = barColor
        @Suppress("DEPRECATION")
        window.navigationBarColor = barColor
        WindowInsetsControllerCompat(window, window.decorView).apply {
            isAppearanceLightStatusBars = false
            isAppearanceLightNavigationBars = false
        }
    }

    fun installBlurLayer(activity: Activity) {
        val layer = activity.findViewById<View>(R.id.blur_layer) ?: return
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            applyBlur(layer)
        } else {
            layer.alpha = FALLBACK_LAYER_ALPHA
        }
    }

    @RequiresApi(Build.VERSION_CODES.S)
    private fun applyBlur(layer: View) {
        val density = layer.resources.displayMetrics.density
        val radius = BLUR_RADIUS_DP * density
        layer.setRenderEffect(
            RenderEffect.createBlurEffect(radius, radius, Shader.TileMode.CLAMP)
        )
    }
}
