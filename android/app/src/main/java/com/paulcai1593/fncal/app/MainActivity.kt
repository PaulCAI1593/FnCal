package com.paulcai1593.fncal.app

import android.annotation.SuppressLint
import android.app.DownloadManager
import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Environment
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.view.Menu
import android.view.MotionEvent
import android.view.View
import android.view.ViewConfiguration
import android.webkit.CookieManager
import android.webkit.DownloadListener
import android.webkit.JavascriptInterface
import android.webkit.SslErrorHandler
import android.webkit.URLUtil
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
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
import org.json.JSONObject
import java.net.InetAddress
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
        /** 0.3.8：页面加载给的时限。超时就切错误页，不再无限转圈。 */
        private const val LOAD_TIMEOUT_MS = 15_000L
        /** 0.3.8：诊断块最多保留的失败请求条数（内存，不落盘）。 */
        private const val DIAG_MAX = 5
        // 0.3.0 §D：UA 带机型，服务端「我的安全」因此能显示是哪台手机。
    private val UA_SUFFIX = " FnCalAndroid/0.3.8" + DeviceName.suffix()
    }

    private lateinit var webView: WebView
    private lateinit var progress: ProgressBar
    private lateinit var errorView: View
    private lateinit var errorTitle: TextView
    private lateinit var errorText: TextView
    private lateinit var diagText: TextView
    private var lastBackAt = 0L
    private var fileCallback: ValueCallback<Array<Uri>>? = null

    /** 0.3.8：加载超时计时。只保留一个，重复调用先清旧的。 */
    private val mainHandler = Handler(Looper.getMainLooper())
    private var loadTimeout: Runnable? = null
    private var loadStartedAt = 0L

    /** 0.3.8：诊断数据。JS 侧通过 FnCalDiag.report 写入，界面只读最近一条。 */
    private val diag = DiagStore(DIAG_MAX)

    /** 0.3.8：DNS 结果行。解析在后台线程做，结果只进诊断块。 */
    @Volatile
    private var dnsLine: String? = null
    private var dnsToken = 0

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
        errorTitle = findViewById(R.id.error_title)
        errorText = findViewById(R.id.error_text)
        diagText = findViewById(R.id.diag_text)
        findViewById<Button>(R.id.btn_retry).setOnClickListener { loadHome() }
        findViewById<Button>(R.id.btn_change_address).setOnClickListener { changeAddress() }
        findViewById<Button>(R.id.btn_copy_diag).setOnClickListener { copyDiagnostics() }

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
        webView.addJavascriptInterface(DiagBridge(), "FnCalDiag")

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
                // 0.3.8：页面一开始加载就重新计时；重定向各自 15 秒。
                scheduleLoadTimeout()
                injectShell(view)
            }

            override fun onPageFinished(view: WebView, url: String?) {
                super.onPageFinished(view, url)
                clearLoadTimeout()
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
                if (!request.isForMainFrame) {
                    // 0.3.8：子资源失败不弹错误页，只留一条诊断。
                    val url = request.url?.toString().orEmpty()
                    if (url.isNotBlank()) {
                        diag.record(
                            DiagEntry(
                                url = url,
                                method = request.method ?: "GET",
                                status = 0,
                                ms = 0L,
                                message = error.description?.toString().orEmpty(),
                            ),
                        )
                        if (errorView.visibility == View.VISIBLE) renderDiag()
                    }
                    return
                }
                clearLoadTimeout()
                showError(
                    getString(R.string.error_generic_title),
                    getString(R.string.error_load_failed, error.description?.toString().orEmpty()),
                )
            }

            override fun onReceivedHttpError(
                view: WebView,
                request: WebResourceRequest,
                errorResponse: WebResourceResponse,
            ) {
                super.onReceivedHttpError(view, request, errorResponse)
                val code = errorResponse.statusCode
                // 0.3.8：主框架 403 / 5xx 也进错误页；子资源失败只留在诊断里。
                if (!request.isForMainFrame) {
                    // 0.3.8：子资源 403 / 5xx 也只留诊断。
                    val url = request.url?.toString().orEmpty()
                    if (url.isNotBlank()) {
                        diag.record(
                            DiagEntry(
                                url = url,
                                method = request.method ?: "GET",
                                status = code,
                                ms = 0L,
                                message = "HTTP " + code,
                            ),
                        )
                        if (errorView.visibility == View.VISIBLE) renderDiag()
                    }
                    return
                }
                if (code != 403 && code < 500) return
                clearLoadTimeout()
                showError(
                    getString(R.string.error_http_title, code),
                    getString(R.string.error_http_body),
                )
            }

            override fun onReceivedSslError(
                view: WebView,
                handler: SslErrorHandler,
                error: android.net.http.SslError,
            ) {
                clearLoadTimeout()
                if (ShellPrefs.allowSelfSigned(this@MainActivity)) {
                    handler.proceed()
                } else {
                    handler.cancel()
                    showError(getString(R.string.error_generic_title), getString(R.string.error_ssl))
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
        clearLoadTimeout()
        errorView.visibility = View.GONE
        progress.visibility = View.VISIBLE
        loadStartedAt = SystemClock.elapsedRealtime()
        // 0.3.8：loadUrl 之前先起计时；onPageStarted 会再起一次（重定向各自计时）。
        scheduleLoadTimeout()
        webView.loadUrl(targetUrl(baseUrl))
    }

    /** 0.3.8：15 秒还没完成就切错误页。重复调用先清旧的，避免叠多个。 */
    private fun scheduleLoadTimeout() {
        clearLoadTimeout()
        val runnable = Runnable {
            loadTimeout = null
            if (progress.visibility == View.VISIBLE && errorView.visibility != View.VISIBLE) {
                progress.visibility = View.GONE
                val elapsed = SystemClock.elapsedRealtime() - loadStartedAt
                diag.record(
                    DiagEntry(
                        url = targetUrl(ShellPrefs.baseUrl(this) ?: ""),
                        method = "GET",
                        status = 0,
                        ms = elapsed,
                        message = getString(R.string.diag_timeout_message),
                    ),
                )
                showError(getString(R.string.error_timeout_title), getString(R.string.error_timeout_body))
            }
        }
        loadTimeout = runnable
        mainHandler.postDelayed(runnable, LOAD_TIMEOUT_MS)
    }

    private fun clearLoadTimeout() {
        loadTimeout?.let { mainHandler.removeCallbacks(it) }
        loadTimeout = null
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

    /**
     * 0.3.8：错误页 = 标题（一句话原因）+ 正文（事实）+ 诊断块。
     * 诊断块读最近一条失败请求与 DNS 结果，没有记录时写「没有失败的请求记录」。
     */
    private fun showError(title: String, body: String) {
        progress.visibility = View.GONE
        errorTitle.text = title
        errorText.text = body
        errorView.visibility = View.VISIBLE
        dnsLine = null
        renderDiag()
        startDnsLookup()
    }

    private fun renderDiag() {
        if (!::diagText.isInitialized) return
        val lines = mutableListOf<String>()
        val entry = diag.latest()
        if (entry == null) {
            lines += getString(R.string.diag_none)
        } else {
            lines += getString(R.string.diag_label_request) + "：" + entry.method + " " + entry.url
            val status = if (entry.status > 0) entry.status.toString() else getString(R.string.diag_status_none)
            lines += getString(R.string.diag_label_result) + "：" + status + " · " +
                entry.ms + " " + getString(R.string.diag_ms)
            if (entry.message.isNotBlank()) {
                lines += getString(R.string.diag_label_error) + "：" + entry.message
            }
        }
        lines += getString(R.string.diag_label_dns) + "：" + (dnsLine ?: getString(R.string.diag_dns_pending))
        lines += getString(R.string.diag_label_env) + "：" + envSummary()
        diagText.text = lines.joinToString("\n")
    }

    private fun envSummary(): String {
        val version = shellVersion()
        val base = ShellPrefs.baseUrl(this).orEmpty()
        return base + " · " + version + " · Android " + Build.VERSION.RELEASE + " (" + Build.VERSION.SDK_INT + ")"
    }

    /** 外壳版本取包信息里的 versionName（由 Gradle 打进包里）。 */
    @Suppress("DEPRECATION")
    private fun shellVersion(): String = try {
        packageManager.getPackageInfo(packageName, 0).versionName ?: "0.3.8"
    } catch (e: Exception) {
        "0.3.8"
    }

    /** 0.3.8：后台解析域名，最多等 2 秒；结果只进诊断块，不挡住错误页。 */
    private fun startDnsLookup() {
        val host = try {
            Uri.parse(ShellPrefs.baseUrl(this).orEmpty()).host
        } catch (e: Exception) {
            null
        }
        if (host.isNullOrBlank()) {
            dnsLine = getString(R.string.diag_dns_fail) + "（没有主机名）"
            renderDiag()
            return
        }
        val token = ++dnsToken
        Thread {
            val started = SystemClock.elapsedRealtime()
            val text = try {
                val addresses = InetAddress.getAllByName(host)
                val ms = SystemClock.elapsedRealtime() - started
                getString(R.string.diag_dns_ok) + "：" + addresses.joinToString(", ") { it.hostAddress ?: "" } +
                    " · " + ms + " " + getString(R.string.diag_ms)
            } catch (e: Exception) {
                getString(R.string.diag_dns_fail) + "：" + (e.javaClass.simpleName)
            }
            mainHandler.post {
                if (token != dnsToken) return@post
                dnsLine = text
                if (errorView.visibility == View.VISIBLE) renderDiag()
            }
        }.apply { isDaemon = true }.start()
        // 0.3.8：2 秒还没结果就写「域名解析超时」，并让后台结果作废（token 前进）。
        mainHandler.postDelayed({
            if (token == dnsToken && dnsLine == null) {
                dnsToken++
                dnsLine = getString(R.string.diag_dns_timeout)
                if (errorView.visibility == View.VISIBLE) renderDiag()
            }
        }, 2_000L)
    }

    /** 0.3.8：「复制诊断」把地址、版本、失败请求、DNS 结果拼成纯文本进剪贴板。 */
    private fun copyDiagnostics() {
        val text = buildString {
            append(getString(R.string.diag_copy_title)).append('\n')
            append(getString(R.string.about_address)).append('：')
                .append(ShellPrefs.baseUrl(this@MainActivity).orEmpty()).append('\n')
            append(getString(R.string.about_app_version)).append('：')
                .append(shellVersion()).append('\n')
            append("Android：").append(Build.VERSION.RELEASE).append("（").append(Build.VERSION.SDK_INT).append("）\n")
            val entry = diag.latest()
            append('\n')
            if (entry == null) {
                append(getString(R.string.diag_none)).append('\n')
            } else {
                append(getString(R.string.diag_label_request)).append('：')
                    .append(entry.method).append(' ').append(entry.url).append('\n')
                val status = if (entry.status > 0) entry.status.toString() else getString(R.string.diag_status_none)
                append(getString(R.string.diag_label_result)).append('：').append(status).append(" · ")
                    .append(entry.ms).append(' ').append(getString(R.string.diag_ms)).append('\n')
                if (entry.message.isNotBlank()) {
                    append(getString(R.string.diag_label_error)).append('：').append(entry.message).append('\n')
                }
            }
            append(getString(R.string.diag_label_dns)).append('：')
                .append(dnsLine ?: getString(R.string.diag_dns_pending))
        }
        try {
            val manager = getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
            manager.setPrimaryClip(ClipData.newPlainText(getString(R.string.diag_copy_title), text))
            Toast.makeText(this, getString(R.string.diag_copied), Toast.LENGTH_SHORT).show()
        } catch (e: Exception) {
            Toast.makeText(this, getString(R.string.fail_other), Toast.LENGTH_SHORT).show()
        }
    }

    /** 0.3.8：网页里的 fetch 失败 / 超时会调这个接口写一条诊断。 */
    inner class DiagBridge {
        @JavascriptInterface
        fun report(payload: String) {
            val json = try {
                JSONObject(payload)
            } catch (e: Exception) {
                return
            }
            val url = json.optString("url")
            if (url.isBlank()) return
            diag.record(
                DiagEntry(
                    url = url,
                    method = json.optString("method", "GET"),
                    status = json.optInt("status", 0),
                    ms = json.optLong("ms", 0L),
                    message = json.optString("message"),
                ),
            )
            // 只在错误页可见时刷新诊断块；可见性要在主线程读。
            mainHandler.post {
                if (errorView.visibility == View.VISIBLE) renderDiag()
            }
        }
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
        clearLoadTimeout()
        dnsToken++
        try {
            webView.removeJavascriptInterface("FnCalSave")
            webView.removeJavascriptInterface("FnCalDiag")
            webView.destroy()
        } catch (e: Exception) {
            // 忽略：退出时 WebView 已被系统回收。
        }
        super.onDestroy()
    }
}

/** 0.3.8：一条失败请求的诊断数据。status = 0 表示没有收到响应。 */
data class DiagEntry(
    val url: String,
    val method: String,
    val status: Int,
    val ms: Long,
    val message: String,
)

/**
 * 0.3.8：最近失败请求的环形存储。
 *
 * - 只在内存，不落盘；
 * - 同一 URL 只留最新一条，避免同一页反复失败刷屏；
 * - 最多 [capacity] 条，超了丢最旧的。
 */
class DiagStore(private val capacity: Int) {
    private val items = LinkedHashMap<String, DiagEntry>()

    @Synchronized
    fun record(entry: DiagEntry) {
        items.remove(entry.url)
        items[entry.url] = entry
        while (items.size > capacity) {
            val oldest = items.keys.firstOrNull() ?: break
            items.remove(oldest)
        }
    }

    @Synchronized
    fun latest(): DiagEntry? = items.values.lastOrNull()

    @Synchronized
    fun size(): Int = items.size
}

