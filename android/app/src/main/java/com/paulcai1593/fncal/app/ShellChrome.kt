package com.paulcai1593.fncal.app

import android.app.Activity
import android.content.res.Configuration
import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.RenderEffect
import android.graphics.Shader
import android.os.Build
import android.view.View
import android.widget.ImageView
import androidx.annotation.RequiresApi
import androidx.core.content.ContextCompat
import androidx.core.view.ViewCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat

/**
 * 0.2.2（真源 `code/app/api/approval-page.mjs`）：三页共用的沉浸式外壳与背景。
 *
 * 1. [applyWindow] edge-to-edge：`setDecorFitsSystemWindows(window, false)`，
 *    状态栏 / 导航栏透明；API 29+ 关掉导航栏对比度强制；图标明暗跟随主题。
 * 2. [applyInsets] 用 WindowInsets 给内容容器补上下内距，不写死 24dp；键盘只压内容区。
 *    地址页 / 关于页传 `shell_body`（ScrollView），背景 `backdrop` 才能铺满系统栏；
 * 3. [installBackdrop] 把「渐变 + 白光高光」画成一张位图放进 backdrop，API 31+
 *    用 RenderEffect 做真模糊（半径 18dp，对齐真源 `blur(18px)`）；API 24–30
 *    没有 backdrop-filter，按真源 `@supports` 回退把玻璃层提高到 96% 不透明。
 *
 * 卡片本身保持实色、不参与模糊——真源 `.glass` 之外的卡片都是不透明底。
 */
object ShellChrome {

    /** 真模糊半径；18dp 对齐真源 `backdrop-filter: blur(18px)`。 */
    private const val BLUR_RADIUS_DP = 18f

    fun applyWindow(activity: Activity) {
        val window = activity.window
        WindowCompat.setDecorFitsSystemWindows(window, false)

        @Suppress("DEPRECATION")
        window.statusBarColor = Color.TRANSPARENT
        @Suppress("DEPRECATION")
        window.navigationBarColor = Color.TRANSPARENT

        // 三键导航时系统默认给导航栏加对比度遮罩，渐变底上会压出一条灰带。
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

    fun installBackdrop(activity: Activity) {
        val host = activity.findViewById<ImageView>(R.id.backdrop) ?: return
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.S) {
            // 无 backdrop-filter：真源用 96% 不透明底保证对比（approval-page.mjs:220-225）。
            host.setImageResource(R.drawable.bg_shell_gradient)
            activity.findViewById<View>(R.id.glass_card)
                ?.setBackgroundResource(R.drawable.bg_glass_solid)
            return
        }
        host.post {
            if (host.width <= 0 || host.height <= 0) return@post
            compositeBackdrop(activity, host)
        }
    }

    @RequiresApi(Build.VERSION_CODES.S)
    private fun compositeBackdrop(activity: Activity, host: ImageView) {
        val w = host.width
        val h = host.height
        val bitmap = Bitmap.createBitmap(w, h, Bitmap.Config.ARGB_8888)
        val canvas = Canvas(bitmap)
        intArrayOf(R.drawable.bg_shell_gradient, R.drawable.bg_shell_glow).forEach { id ->
            val drawable = ContextCompat.getDrawable(activity, id) ?: return@forEach
            drawable.setBounds(0, 0, w, h)
            drawable.draw(canvas)
        }
        host.setImageBitmap(bitmap)
        val radius = BLUR_RADIUS_DP * host.resources.displayMetrics.density
        host.setRenderEffect(
            RenderEffect.createBlurEffect(radius, radius, Shader.TileMode.CLAMP)
        )
    }
}
