package com.paulcai1593.fncal.app

import android.annotation.SuppressLint
import android.app.DownloadManager
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Environment
import android.view.Menu
import android.view.MotionEvent
import android.view.View
import android.view.ViewConfiguration
import android.webkit.CookieManager
import android.webkit.DownloadListener
import android.webkit.SslErrorHandler
import android.webkit.URLUtil
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.Button
import android.widget.ImageButton
import android.widget.ProgressBar
import android.widget.TextView
import android.widget.Toast
import androidx.appcompat.app.AppCompatActivity
import androidx.core.app.ActivityCompat
import androidx.core.content.ContextCompat
import kotlin.math.abs

/**
 * 主界面：全屏 WebView 打开已保存的 FnCal 地址。
 *
 * 外壳不硬编码任何 FnCal 页面路径 —— 登录、月视图、设置全部走网页原有流程。
 */
class MainActivity : AppCompatActivity() {

    companion object {
        /** 0.3.0：桌面卡片点进来时带的视图与日期（Web 端 hash 深链）。 */
        const val EXTRA_VIEW = "fncal.view"
        const val EXTRA_DATE = "fncal.date"

        private const val REQ_PICK_FILE = 2001
        private const val REQ_STORAGE_PERMISSION = 2002
        private const val MENU_REFRESH = 1
        private const val MENU_ABOUT = 2
        private const val DOUBLE_BACK_WINDOW_MS = 2_000L
        // 0.3.0 §D：UA 带机型，服务端「我的安全」因此能显示是哪台手机。
    private val UA_SUFFIX = " FnCalAndroid/0.3.7" + DeviceName.suffix()
    }

    private lateinit var webView: WebView
    private lateinit var progress: ProgressBar
    private lateinit var errorView: View
    private lateinit var errorText: TextView
    private var lastBackAt = 0L
    private var fileCallback: ValueCallback<Array<Uri>>? = null

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        val baseUrl = ShellPrefs.baseUrl(this)
        if (baseUrl.isNullOrBlank()) {
            startActivity(Intent(this, AddressActivity::class.java))
            finish()
            return
        }

        setContentView(R.layout.activity_main)
        // 0.2.1（§S2-2b）：WebView 也 edge-to-edge；内容用 insets 留在安全区内，
        // 顶不压状态栏、底不压手势条，三点菜单与底部区域都可点。
        ShellChrome.applyWindow(this)
        ShellChrome.applyInsets(findViewById(R.id.shell_root))
        webView = findViewById(R.id.web_view)
        progress = findViewById(R.id.progress)
        errorView = findViewById(R.id.error_view)
        errorText = findViewById(R.id.error_text)
        findViewById<Button>(R.id.btn_retry).setOnClickListener { loadHome() }
        findViewById<Button>(R.id.btn_change_address).setOnClickListener { changeAddress() }

        setupWebView()
        setupShellMenu()
        requestLegacyStoragePermissionIfNeeded()
        loadHome()
    }

    private fun setupWebView() {
        val settings = webView.settings
        settings.javaScriptEnabled = true
        settings.domStorageEnabled = true
        settings.databaseEnabled = true
        settings.javaScriptCanOpenWindowsAutomatically = false
        settings.setSupportMultipleWindows(false)
        settings.mediaPlaybackRequiresUserGesture = true
        settings.userAgentString = (settings.userAgentString ?: "") + UA_SUFFIX

        CookieManager.getInstance().setAcceptCookie(true)
        CookieManager.getInstance().setAcceptThirdPartyCookies(webView, false)
        CookieManager.getInstance().flush()

        webView.addJavascriptInterface(BlobSaver(this), "FnCalSave")

        webView.webViewClient = object : WebViewClient() {
            override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
                val target = request.url?.toString().orEmpty()
                if (target.isEmpty()) return false
                if (isSameOrigin(target, ShellPrefs.baseUrl(this@MainActivity))) return false
                openExternal(target)
                return true
            }

            override fun onPageStarted(view: WebView, url: String?, favicon: android.graphics.Bitmap?) {
                super.onPageStarted(view, url, favicon)
                progress.visibility = View.VISIBLE
                injectShell(view)
            }

            override fun onPageFinished(view: WebView, url: String?) {
                super.onPageFinished(view, url)
                progress.visibility = View.GONE
                CookieManager.getInstance().flush()
                // 有些跳转不重走 onPageStarted（例如整页替换），再注入一次；脚本自带安装守卫。
                injectShell(view)
            }

            override fun onReceivedError(
                view: WebView,
                request: WebResourceRequest,
                error: WebResourceError,
            ) {
                super.onReceivedError(view, request, error)
                if (request.isForMainFrame) {
                    showError(getString(R.string.error_load_failed, error.description?.toString().orEmpty()))
                }
            }

            override fun onReceivedSslError(
                view: WebView,
                handler: SslErrorHandler,
                error: android.net.http.SslError,
            ) {
                if (ShellPrefs.allowSelfSigned(this@MainActivity)) {
                    handler.proceed()
                } else {
                    handler.cancel()
                    showError(getString(R.string.error_ssl))
                }
            }
        }

        webView.webChromeClient = object : WebChromeClient() {
            override fun onProgressChanged(view: WebView, newProgress: Int) {
                if (newProgress >= 100) progress.visibility = View.GONE
            }

            override fun onShowFileChooser(
                webView: WebView,
                filePathCallback: ValueCallback<Array<Uri>>,
                fileChooserParams: WebChromeClient.FileChooserParams,
            ): Boolean {
                fileCallback?.onReceiveValue(null)
                fileCallback = filePathCallback
                val pick = Intent(Intent.ACTION_GET_CONTENT).apply {
                    addCategory(Intent.CATEGORY_OPENABLE)
                    type = "*/*"
                    putExtra(
                        Intent.EXTRA_MIME_TYPES,
                        arrayOf(
                            "text/calendar",
                            "text/x-vcalendar",
                            "application/json",
                            "application/octet-stream",
                            "text/*",
                        ),
                    )
                }
                return try {
                    startActivityForResult(Intent.createChooser(pick, getString(R.string.choose_file)), REQ_PICK_FILE)
                    true
                } catch (e: Exception) {
                    fileCallback = null
                    false
                }
            }
        }

        webView.setDownloadListener(
            DownloadListener { url, userAgent, contentDisposition, mimeType, _ ->
                startDownload(url, userAgent, contentDisposition, mimeType)
            },
        )
    }

    private fun loadHome() {
        val baseUrl = ShellPrefs.baseUrl(this) ?: return
        errorView.visibility = View.GONE
        progress.visibility = View.VISIBLE
        webView.loadUrl(targetUrl(baseUrl))
    }

    /**
     * 点桌面卡片进来时，在地址后加 hash：`#fncal-view=month&fncal-date=2026-11-07`。
     *
     * 只是给网页一个初始视图与日期，不改用户的默认视图设置；
     * 网页没有这段逻辑时 hash 被忽略，行为与原来一致。
     */
    private fun targetUrl(baseUrl: String): String {
        val view = intent?.getStringExtra(EXTRA_VIEW)?.takeIf { it.isNotBlank() } ?: return baseUrl
        val date = intent?.getStringExtra(EXTRA_DATE)
        val hash = buildString {
            append("fncal-view=").append(Uri.encode(view))
            if (!date.isNullOrBlank()) {
                append("&fncal-date=").append(Uri.encode(date))
            }
        }
        val separator = if (baseUrl.contains('#')) "&" else "#"
        return baseUrl + separator + hash
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        if (::webView.isInitialized) loadHome()
    }

    private fun injectShell(view: WebView?) {
        val script = try {
            assets.open("shell.js").bufferedReader().use { it.readText() }
        } catch (e: Exception) {
            return
        }
        view?.evaluateJavascript(script, null)
    }

    private fun isSameOrigin(target: String, base: String?): Boolean {
        if (base.isNullOrBlank()) return false
        return try {
            val a = Uri.parse(target)
            val b = Uri.parse(base)
            a.scheme.equals(b.scheme, ignoreCase = true) &&
                a.host.equals(b.host, ignoreCase = true) &&
                effectivePort(a) == effectivePort(b)
        } catch (e: Exception) {
            false
        }
    }

    private fun effectivePort(uri: Uri): Int {
        if (uri.port != -1) return uri.port
        return if (uri.scheme.equals("https", ignoreCase = true)) 443 else 80
    }

    private fun openExternal(url: String) {
        try {
            startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(url)))
        } catch (e: Exception) {
            Toast.makeText(this, getString(R.string.fail_other), Toast.LENGTH_SHORT).show()
        }
    }

    private fun startDownload(url: String, userAgent: String, contentDisposition: String, mimeType: String) {
        try {
            val fileName = URLUtil.guessFileName(url, contentDisposition, mimeType)
            val request = DownloadManager.Request(Uri.parse(url)).apply {
                setMimeType(mimeType)
                addRequestHeader("User-Agent", userAgent)
                setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED)
                setDestinationInExternalPublicDir(Environment.DIRECTORY_DOWNLOADS, "FnCal/$fileName")
            }
            val manager = getSystemService(Context.DOWNLOAD_SERVICE) as DownloadManager
            manager.enqueue(request)
            Toast.makeText(this, R.string.download_started, Toast.LENGTH_SHORT).show()
        } catch (e: Exception) {
            Toast.makeText(this, getString(R.string.fail_other), Toast.LENGTH_SHORT).show()
        }
    }

    private fun showError(message: String) {
        progress.visibility = View.GONE
        errorText.text = message
        errorView.visibility = View.VISIBLE
    }

    private fun changeAddress() {
        val intent = Intent(this, AddressActivity::class.java)
        intent.putExtra(AddressActivity.EXTRA_EDIT, true)
        startActivity(intent)
    }

    private fun requestLegacyStoragePermissionIfNeeded() {
        if (Build.VERSION.SDK_INT > Build.VERSION_CODES.P) return
        val granted = ContextCompat.checkSelfPermission(
            this,
            android.Manifest.permission.WRITE_EXTERNAL_STORAGE,
        ) == android.content.pm.PackageManager.PERMISSION_GRANTED
        if (!granted) {
            ActivityCompat.requestPermissions(
                this,
                arrayOf(android.Manifest.permission.WRITE_EXTERNAL_STORAGE),
                REQ_STORAGE_PERMISSION,
            )
        }
    }

    private fun setupShellMenu() {
        // 主题是 NoActionBar（WebView 全屏），OptionsMenu 不会显示；用右下角浮层按钮 + PopupMenu。
        // 按钮可拖动：网页右下角也可能有可点元素，拖开即可；位置限制在父容器内。
        val button = findViewById<ImageButton>(R.id.btn_menu)
        val popup = androidx.appcompat.widget.PopupMenu(this, button)
        popup.menu.add(Menu.NONE, MENU_REFRESH, 0, R.string.menu_refresh)
        popup.menu.add(Menu.NONE, MENU_ABOUT, 1, R.string.menu_about)
        popup.setOnMenuItemClickListener { item ->
            when (item.itemId) {
                MENU_REFRESH -> {
                    loadHome()
                    true
                }

                MENU_ABOUT -> {
                    startActivity(Intent(this, AboutActivity::class.java))
                    true
                }

                else -> false
            }
        }
        button.setOnClickListener { popup.show() }
        attachMenuDrag(button)
    }

    /** 拖动浮层按钮；轻点仍然弹出菜单。 */
    private fun attachMenuDrag(button: View) {
        val slop = ViewConfiguration.get(this).scaledTouchSlop
        var downRawX = 0f
        var downRawY = 0f
        var startX = 0f
        var startY = 0f
        var dragging = false
        button.setOnTouchListener { view, event ->
            when (event.actionMasked) {
                MotionEvent.ACTION_DOWN -> {
                    downRawX = event.rawX
                    downRawY = event.rawY
                    startX = view.translationX
                    startY = view.translationY
                    dragging = false
                    true
                }

                MotionEvent.ACTION_MOVE -> {
                    val dx = event.rawX - downRawX
                    val dy = event.rawY - downRawY
                    if (!dragging && (abs(dx) > slop || abs(dy) > slop)) dragging = true
                    if (dragging) {
                        val parent = view.parent as? View
                        val parentWidth = (parent?.width ?: view.width).toFloat()
                        val parentHeight = (parent?.height ?: view.height).toFloat()
                        val minX = -view.left.toFloat()
                        val minY = -view.top.toFloat()
                        val maxX = parentWidth - view.width - view.left
                        val maxY = parentHeight - view.height - view.top
                        view.translationX = (startX + dx).coerceIn(minX, maxX)
                        view.translationY = (startY + dy).coerceIn(minY, maxY)
                    }
                    true
                }

                MotionEvent.ACTION_UP -> {
                    if (!dragging) view.performClick()
                    true
                }

                MotionEvent.ACTION_CANCEL -> true
                else -> false
            }
        }
    }

    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        if (requestCode == REQ_PICK_FILE) {
            val callback = fileCallback
            fileCallback = null
            val result = if (resultCode == RESULT_OK) {
                WebChromeClient.FileChooserParams.parseResult(resultCode, data)
            } else {
                null
            }
            callback?.onReceiveValue(result)
            return
        }
        super.onActivityResult(requestCode, resultCode, data)
    }

    @Deprecated("v0.1.0 用兼容的返回键处理；升级到 AndroidX 的 OnBackPressedDispatcher 需要额外依赖。")
    override fun onBackPressed() {
        if (webView.canGoBack()) {
            webView.goBack()
            return
        }
        val now = System.currentTimeMillis()
        if (now - lastBackAt < DOUBLE_BACK_WINDOW_MS) {
            super.onBackPressed()
            return
        }
        lastBackAt = now
        Toast.makeText(this, R.string.back_again_to_exit, Toast.LENGTH_SHORT).show()
    }

    override fun onPause() {
        webView.onPause()
        CookieManager.getInstance().flush()
        super.onPause()
    }

    override fun onResume() {
        super.onResume()
        webView.onResume()
        // 0.6.2 §F：壳内登录 / 退出后回来，主动让卡片取一次新数据（Cookie 已更新）。
        WidgetScheduler.refreshNow(this)
    }

    override fun onDestroy() {
        try {
            webView.removeJavascriptInterface("FnCalSave")
            webView.destroy()
        } catch (e: Exception) {
            // 忽略：退出时 WebView 已被系统回收。
        }
        super.onDestroy()
    }
}
