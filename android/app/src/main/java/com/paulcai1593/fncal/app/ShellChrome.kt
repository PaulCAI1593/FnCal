package com.paulcai1593.fncal.app

import android.app.Activity
import android.content.res.Configuration
import android.graphics.Color
import android.graphics.RenderEffect
import android.graphics.Shader
import android.os.Build
import android.view.View
import androidx.annotation.RequiresApi
import androidx.core.view.ViewCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat

/**
 * 0.2.1（范围文档 §S2-2b）：三页共用的沉浸式外壳与背景处理。
 *
 * 三件事：
 * 1. [applyWindow] edge-to-edge：`setDecorFitsSystemWindows(window, false)`，
 *    状态栏 / 导航栏透明；API 29+ 关掉导航栏对比度强制（手势条下不出灰条）；
 *    状态栏与导航栏图标明暗跟随系统主题（深色主题用浅色图标）。
 * 2. [applyInsets] 用 WindowInsets 给根容器补上下内距：顶部补状态栏，底部取
 *    「导航栏 / 手势条」与「输入法」的较大值——不写死 24dp，键盘弹出只压内容区。
 * 3. [installBlurLayer] 只给背景光斑层做模糊：API 31+ 用 RenderEffect 真模糊，
 *    API 24–30 降级为半透明光斑（多层叠加观感），不崩、不黑块。
 *
 * 卡片本身不模糊（§S2）。
 */
object ShellChrome {

    /** 真模糊半径；28dp 时 390dp 宽屏上接近 CSS blur(18px) 的观感。 */
    private const val BLUR_RADIUS_DP = 28f

    /** API 24–30 的降级透明度：光斑淡一些，避免比卡片更抢眼。 */
    private const val FALLBACK_LAYER_ALPHA = 0.55f

    fun applyWindow(activity: Activity) {
        val window = activity.window
        WindowCompat.setDecorFitsSystemWindows(window, false)

        @Suppress("DEPRECATION")
        window.statusBarColor = Color.TRANSPARENT
        @Suppress("DEPRECATION")
        window.navigationBarColor = Color.TRANSPARENT

        // 三键导航时系统默认给导航栏加对比度遮罩，深色渐变下会压出一条灰带。
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            @Suppress("DEPRECATION")
            window.isNavigationBarContrastEnforced = false
        }

        val night = (activity.resources.configuration.uiMode and
            Configuration.UI_MODE_NIGHT_MASK) == Configuration.UI_MODE_NIGHT_YES
        WindowInsetsControllerCompat(window, window.decorView).apply {
            // 浅色主题用深色图标，深色主题用浅色图标。
            isAppearanceLightStatusBars = !night
            isAppearanceLightNavigationBars = !night
        }
    }

    /**
     * 给根容器补系统栏内距。根容器自身的 padding 必须是 0（布局里不写死），
     * 这里统一覆盖为 top=状态栏、bottom=max(导航栏, 输入法)。
     */
    fun applyInsets(root: View) {
        ViewCompat.setOnApplyWindowInsetsListener(root) { view, insets ->
            val bars = insets.getInsets(WindowInsetsCompat.Type.systemBars())
            val ime = insets.getInsets(WindowInsetsCompat.Type.ime())
            view.setPadding(0, bars.top, 0, maxOf(bars.bottom, ime.bottom))
            insets
        }
        ViewCompat.requestApplyInsets(root)
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
