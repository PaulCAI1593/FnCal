package com.paulcai1593.fncal.app

import android.app.DownloadManager
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Environment
import android.os.Handler
import android.os.Looper
import android.provider.Settings
import android.view.View
import android.webkit.CookieManager
import android.webkit.WebStorage
import android.webkit.WebView
import android.widget.Button
import android.widget.ProgressBar
import android.widget.RadioButton
import android.widget.RadioGroup
import android.widget.TextView
import android.widget.Toast
import androidx.appcompat.app.AlertDialog
import androidx.appcompat.app.AppCompatActivity
import androidx.core.content.ContextCompat
import androidx.core.content.FileProvider
import java.io.File
import kotlin.concurrent.thread

/**
 * 关于页：应用版本、服务器版本、当前地址、修改地址、清除 Cookie 与缓存，
 * 以及 0.2.0 新增的「检查更新」（范围文档 §B4）。
 *
 * 更新流程：点按钮 → 后台取清单（国内源失败自动改试直通）→ versionCode 更大才提示
 * → 用户确认 → 系统 DownloadManager 下载 → **以它回写的 COLUMN_LOCAL_URI 为准取包**
 * （content:// 先复制进 cacheDir/updates）→ 校验包名与 versionCode → ACTION_VIEW 交给
 * 系统安装器。未点按钮时没有任何网络请求。
 * 0.3.4：下载失败带原因码；目标文件已存在时清掉重下一次；磁盘上已有正确包时直接装。
 */
class AboutActivity : AppCompatActivity() {

    companion object {
        /** 下载进度的轮询间隔；DownloadManager 没有回调接口，只能 query。 */
        private const val POLL_INTERVAL_MS = 500L
        private const val INSTALL_MIME = "application/vnd.android.package-archive"

        /**
         * 0.3.4 §B：DownloadManager.ERROR_FILE_ALREADY_EXISTS 的数值（1009）。
         * 直接引用该常量在个别 SDK 版本上不可见，这里写死；原因码对照表见记录 §5。
         */
        private const val DM_ERROR_FILE_ALREADY_EXISTS = 1009
        /** DownloadManager 写盘的外部私有目录（相对 getExternalFilesDir(DOWNLOADS)）。 */
        private const val EXTERNAL_UPDATES_DIR = "FnCal/updates"
        /** content:// 落盘时的复制目录（相对 cacheDir）。 */
        private const val CACHE_UPDATES_DIR = "updates"
    }

    private lateinit var radioSourceCn: RadioButton
    private lateinit var radioSourceDirect: RadioButton
    private lateinit var buttonCheckUpdate: Button
    private lateinit var progressUpdate: ProgressBar
    private lateinit var textUpdateStatus: TextView
    private lateinit var textUpdateDiag: TextView
    private lateinit var buttonCancelUpdate: Button
    private lateinit var widgetStatus: TextView
    private lateinit var buttonWidgetRefresh: Button

    private val handler = Handler(Looper.getMainLooper())
    private var downloadId = -1L
    private var expectedVersionCode = 0
    private var expectedApkName = ""
    private var polling = false

    // ---- 0.3.4 更新收尾状态 ----
    /** 最近一次「下载并安装」的清单与源：文件已存在时重试一次要复用同一请求。 */
    private var lastManifest: UpdateChecker.Manifest? = null
    private var lastSource: UpdateSources.Source = UpdateSources.Source.CN
    /** ERROR_FILE_ALREADY_EXISTS 的自愈重试是否已用过（本会话只一次）。 */
    private var retriedAfterExists = false
    /** 已校验通过、等「安装未知应用」授权后要续装的包。 */
    private var pendingApk: File? = null
    private var pendingInstallArmed = false
    /** 诊断行：最近一次成功取到的落盘位置（只留目录名 + 文件名）。 */
    private var lastLandedPath = "-"

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_about)
        // 0.2.1（§S2-2b）：与地址页同一套 edge-to-edge + 光斑模糊 + insets 内距。
        ShellChrome.applyWindow(this)
        ShellChrome.installBackdrop(this)
        ShellChrome.applyInsets(findViewById(R.id.shell_body))

        val appVersion = try {
            packageManager.getPackageInfo(packageName, 0).versionName.orEmpty()
        } catch (e: Exception) {
            BuildConfig.VERSION_NAME
        }
        val serverVersion = ShellPrefs.serverVersion(this)
        findViewById<TextView>(R.id.text_app_version).text = appVersion
        findViewById<TextView>(R.id.text_server_version).text =
            serverVersion ?: getString(R.string.about_server_version_unknown)
        findViewById<TextView>(R.id.text_connection_status).text =
            getString(
                if (serverVersion.isNullOrBlank()) R.string.about_status_unknown
                else R.string.about_status_connected
            )
        val baseUrl = ShellPrefs.baseUrl(this) ?: "-"
        val addressView = findViewById<TextView>(R.id.text_address)
        addressView.text = baseUrl
        // 0.2.2：单行中间省略；点开弹窗看完整值，避免长地址被截断后无从核对。
        addressView.setOnClickListener {
            AlertDialog.Builder(this)
                .setTitle(R.string.about_address_dialog_title)
                .setMessage(baseUrl)
                .setPositiveButton(R.string.about_ok, null)
                .show()
        }

        findViewById<Button>(R.id.btn_change_address).setOnClickListener {
            clearCookiesAndCache()
            val intent = Intent(this, AddressActivity::class.java).apply {
                putExtra(AddressActivity.EXTRA_EDIT, true)
                flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TASK
            }
            startActivity(intent)
            finish()
        }

        findViewById<Button>(R.id.btn_clear_data).setOnClickListener {
            clearCookiesAndCache()
            Toast.makeText(this, R.string.about_cleared, Toast.LENGTH_SHORT).show()
        }

        setupUpdateCard()
        setupWidgetCard()
    }

    /** 0.6.2 §F：卡片跟随 App 登录态；这里只显示状态并提供手动刷新。 */
    private fun setupWidgetCard() {
        widgetStatus = findViewById(R.id.widget_login_state)
        buttonWidgetRefresh = findViewById(R.id.btn_widget_refresh)
        buttonWidgetRefresh.setOnClickListener { refreshWidgetCard() }
        renderWidgetState()
    }

    private fun renderWidgetState() {
        val signedIn = WidgetRepository.signedIn(this)
        widgetStatus.text = getString(
            if (signedIn) R.string.about_widget_status_signed_in
            else R.string.about_widget_status_signed_out
        )
        widgetStatus.setTextColor(
            ContextCompat.getColor(this, if (signedIn) R.color.text_2 else R.color.error_red)
        )
    }

    private fun refreshWidgetCard() {
        buttonWidgetRefresh.isEnabled = false
        widgetStatus.setTextColor(ContextCompat.getColor(this, R.color.text_2))
        widgetStatus.text = getString(R.string.about_widget_refreshing)
        thread(name = "fncal-widget-refresh") {
            val ok = WidgetRepository.refresh(this)
            runOnUiThread {
                buttonWidgetRefresh.isEnabled = true
                renderWidgetState()
                if (ok) {
                    val updated = WidgetPrefs.lastUpdated(this)
                    val at = if (updated > 0) clock(updated) else null
                    Toast.makeText(
                        this,
                        if (at != null) getString(R.string.about_widget_last_updated, at)
                        else getString(R.string.about_widget_never),
                        Toast.LENGTH_SHORT
                    ).show()
                } else {
                    Toast.makeText(this, R.string.about_widget_refresh_failed, Toast.LENGTH_SHORT).show()
                }
            }
        }
    }

    private fun clock(ms: Long): String =
        java.text.SimpleDateFormat("HH:mm", java.util.Locale.getDefault()).format(java.util.Date(ms))
    // ---- 检查更新（§B4） -------------------------------------------------

    private fun setupUpdateCard() {
        radioSourceCn = findViewById(R.id.radio_source_cn)
        radioSourceDirect = findViewById(R.id.radio_source_direct)
        buttonCheckUpdate = findViewById(R.id.btn_check_update)
        progressUpdate = findViewById(R.id.progress_update)
        textUpdateStatus = findViewById(R.id.text_update_status)
        textUpdateDiag = findViewById(R.id.text_update_diag)
        buttonCancelUpdate = findViewById(R.id.btn_cancel_update)
        val group = findViewById<RadioGroup>(R.id.group_update_source)

        // 恢复上次选择：默认国内源。
        val saved = UpdateSources.Source.fromPref(ShellPrefs.updateSource(this))
        if (saved == UpdateSources.Source.DIRECT) {
            radioSourceDirect.isChecked = true
        } else {
            radioSourceCn.isChecked = true
        }
        group.setOnCheckedChangeListener { _, _ ->
            ShellPrefs.setUpdateSource(this, selectedSource().prefValue)
        }

        buttonCheckUpdate.setOnClickListener {
            checkForUpdate()
        }
        buttonCancelUpdate.setOnClickListener {
            cancelDownload()
        }
    }

    private fun selectedSource(): UpdateSources.Source =
        if (radioSourceDirect.isChecked) UpdateSources.Source.DIRECT else UpdateSources.Source.CN

    private fun checkForUpdate() {
        val source = selectedSource()
        buttonCheckUpdate.isEnabled = false
        progressUpdate.visibility = View.GONE
        buttonCancelUpdate.visibility = View.GONE
        textUpdateStatus.visibility = View.VISIBLE
        textUpdateStatus.text = getString(R.string.update_checking)

        val current = currentVersionCode()
        thread {
            val outcome = UpdateChecker.check(source, current)
            runOnUiThread { onCheckOutcome(outcome) }
        }
    }

    private fun onCheckOutcome(outcome: UpdateChecker.Outcome) {
        buttonCheckUpdate.isEnabled = true
        buttonCheckUpdate.setText(R.string.update_retry)
        when (outcome) {
            is UpdateChecker.Outcome.Failure -> {
                textUpdateStatus.text = getString(R.string.update_check_failed, outcome.message)
            }

            is UpdateChecker.Outcome.Latest -> {
                textUpdateStatus.text = getString(R.string.update_latest, outcome.remoteVersionName)
            }

            is UpdateChecker.Outcome.Found -> {
                textUpdateStatus.text =
                    getString(R.string.update_found_title, outcome.manifest.versionName)
                showUpdateDialog(outcome)
            }
        }
    }

    private fun showUpdateDialog(outcome: UpdateChecker.Outcome.Found) {
        val manifest = outcome.manifest
        val lines = mutableListOf<String>()
        lines.add(
            getString(R.string.update_dialog_version, manifest.versionName, manifest.versionCode)
        )
        lines.add(getString(R.string.update_dialog_date, manifest.releasedAt))
        var sourceLabel = sourceName(outcome.source)
        if (outcome.usedFallback) {
            sourceLabel += "（" + getString(R.string.update_source_fallback) + "）"
        }
        lines.add(getString(R.string.update_dialog_source, sourceLabel))
        if (manifest.notes.isNotEmpty()) {
            lines.add(getString(R.string.update_dialog_notes))
            manifest.notes.forEach { lines.add("· " + it) }
        }
        AlertDialog.Builder(this)
            .setTitle(getString(R.string.update_found_title, manifest.versionName))
            .setMessage(lines.joinToString("\n"))
            .setPositiveButton(R.string.update_download) { _, _ ->
                startDownload(manifest, outcome.source)
            }
            .setNegativeButton(R.string.update_later, null)
            .show()
    }

    private fun sourceName(source: UpdateSources.Source): String =
        getString(
            when (source) {
                UpdateSources.Source.PAGES -> R.string.update_source_pages
                UpdateSources.Source.DIRECT -> R.string.update_source_direct
                UpdateSources.Source.CN -> R.string.update_source_cn
            }
        )

    private fun startDownload(manifest: UpdateChecker.Manifest, source: UpdateSources.Source) {
        expectedVersionCode = manifest.versionCode
        expectedApkName = manifest.apk
        lastManifest = manifest
        lastSource = source
        retriedAfterExists = false

        // 0.3.4 §D：磁盘上已有同版本的正确包（包名 + versionCode 都对）就直接装，
        // 不再重下；这也顺带避开「目标文件已存在」导致的失败。
        val cached = existingValidApk(manifest.apk, manifest.versionCode)
        if (cached != null) {
            pendingApk = cached
            lastLandedPath = landedLabel(cached)
            updateDiag(-1, 0, lastLandedPath)
            textUpdateStatus.visibility = View.VISIBLE
            textUpdateStatus.text = getString(R.string.update_verify)
            verifyAndInstall(cached)
            return
        }

        cleanBeforeDownload(manifest.apk)
        enqueueDownload(manifest, source)
    }

    /** 0.3.4 §B：enqueue 前删掉外部私有目录与缓存里的同名包。 */
    private fun cleanBeforeDownload(apkName: String) {
        externalApkFile(apkName)?.delete()
        File(File(cacheDir, CACHE_UPDATES_DIR), apkName).delete()
    }

    private fun enqueueDownload(manifest: UpdateChecker.Manifest, source: UpdateSources.Source) {
        val manager = getSystemService(Context.DOWNLOAD_SERVICE) as DownloadManager
        val request = DownloadManager.Request(Uri.parse(UpdateSources.apkUrl(source, manifest)))
            .setTitle(getString(R.string.app_name) + " " + manifest.versionName)
            .setDescription(getString(R.string.update_downloading))
            .setMimeType(INSTALL_MIME)
            .setNotificationVisibility(
                DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED
            )
            .setDestinationInExternalFilesDir(
                this,
                Environment.DIRECTORY_DOWNLOADS,
                EXTERNAL_UPDATES_DIR + "/" + manifest.apk
            )
            .setAllowedOverMetered(true)
        downloadId = try {
            manager.enqueue(request)
        } catch (e: Exception) {
            updateDiag(-1, 0, "-")
            textUpdateStatus.visibility = View.VISIBLE
            textUpdateStatus.text = getString(R.string.update_download_failed)
            return
        }
        progressUpdate.visibility = View.VISIBLE
        progressUpdate.progress = 0
        buttonCancelUpdate.visibility = View.VISIBLE
        textUpdateStatus.visibility = View.VISIBLE
        textUpdateStatus.text = getString(R.string.update_downloading)
        buttonCheckUpdate.isEnabled = false
        pollDownload()
    }

    private fun cancelDownload() {
        if (downloadId >= 0L) {
            val manager = getSystemService(Context.DOWNLOAD_SERVICE) as DownloadManager
            manager.remove(downloadId)
            downloadId = -1L
        }
        resetDownloadUi()
        textUpdateStatus.visibility = View.VISIBLE
        textUpdateStatus.text = getString(R.string.update_cancelled)
    }

    private fun pollDownload() {
        if (polling || downloadId < 0L) return
        polling = true
        handler.postDelayed({
            polling = false
            if (downloadId < 0L) return@postDelayed
            readDownloadState()
        }, POLL_INTERVAL_MS)
    }

    private fun readDownloadState() {
        val manager = getSystemService(Context.DOWNLOAD_SERVICE) as DownloadManager
        val cursor = manager.query(DownloadManager.Query().setFilterById(downloadId))
        if (cursor == null) {
            finishDownloadWithFailure()
            return
        }
        cursor.use {
            if (!it.moveToFirst()) {
                finishDownloadWithFailure()
                return
            }
            val status = it.getInt(it.getColumnIndexOrThrow(DownloadManager.COLUMN_STATUS))
            val reasonIndex = it.getColumnIndex(DownloadManager.COLUMN_REASON)
            val reason = if (reasonIndex >= 0) it.getInt(reasonIndex) else 0
            val uriIndex = it.getColumnIndex(DownloadManager.COLUMN_LOCAL_URI)
            val localUri = if (uriIndex >= 0) it.getString(uriIndex) else null
            when (status) {
                DownloadManager.STATUS_SUCCESSFUL -> {
                    progressUpdate.progress = 100
                    textUpdateStatus.text = getString(R.string.update_verify)
                    // 0.3.4 §A：以 DownloadManager 回写的实际落盘 URI 为准。
                    val file = apkFromLocalUri(localUri)
                    if (file == null) {
                        updateDiag(status, reason, "-")
                        finishDownloadWithFailure()
                        return
                    }
                    lastLandedPath = landedLabel(file)
                    updateDiag(status, reason, lastLandedPath)
                    verifyAndInstall(file)
                }

                DownloadManager.STATUS_FAILED -> onDownloadFailed(reason)

                else -> {
                    val total =
                        it.getLong(it.getColumnIndexOrThrow(DownloadManager.COLUMN_TOTAL_SIZE_BYTES))
                    val soFar = it.getLong(
                        it.getColumnIndexOrThrow(DownloadManager.COLUMN_BYTES_DOWNLOADED_SO_FAR)
                    )
                    if (total > 0L) {
                        val percent = ((soFar * 100L) / total).toInt().coerceIn(0, 100)
                        progressUpdate.progress = percent
                        textUpdateStatus.text =
                            getString(R.string.update_download_progress, percent)
                    }
                    updateDiag(status, reason, "-")
                    pollDownload()
                }
            }
        }
    }

    /** 0.3.4 §B：目标文件已存在时清掉同名包再下一次，只重试一次。 */
    private fun onDownloadFailed(reason: Int) {
        updateDiag(DownloadManager.STATUS_FAILED, reason, "-")
        val manifest = lastManifest
        if (reason == DM_ERROR_FILE_ALREADY_EXISTS && !retriedAfterExists && manifest != null) {
            retriedAfterExists = true
            cleanBeforeDownload(expectedApkName)
            downloadId = -1L
            enqueueDownload(manifest, lastSource)
            return
        }
        finishDownloadWithFailure(reason)
    }

    /**
     * 0.3.4 §C：带 DownloadManager 原因码的失败提示。reason 为 0 时沿用原句
     * 「下载失败，请重试」；否则显示「下载失败（原因 N），请重试」。
     */
    private fun finishDownloadWithFailure(reason: Int = 0) {
        downloadId = -1L
        resetDownloadUi()
        textUpdateStatus.visibility = View.VISIBLE
        textUpdateStatus.text =
            if (reason != 0) {
                getString(R.string.update_download_failed_reason, reason)
            } else {
                getString(R.string.update_download_failed)
            }
    }

    private fun resetDownloadUi() {
        progressUpdate.visibility = View.GONE
        buttonCancelUpdate.visibility = View.GONE
        buttonCheckUpdate.isEnabled = true
        buttonCheckUpdate.setText(R.string.check_update)
    }

    private fun externalApkFile(apkName: String): File? {
        val dir = getExternalFilesDir(Environment.DIRECTORY_DOWNLOADS) ?: return null
        return File(File(dir, EXTERNAL_UPDATES_DIR), apkName)
    }

    private fun cachedApkFile(apkName: String): File =
        File(File(cacheDir, CACHE_UPDATES_DIR), apkName)

    /** 0.3.4 §D：目标版本的正确包已在磁盘（包名 + versionCode 都对）时不再下载。 */
    private fun existingValidApk(apkName: String, versionCode: Int): File? {
        val candidates = mutableListOf<File>()
        externalApkFile(apkName)?.let { candidates.add(it) }
        candidates.add(cachedApkFile(apkName))
        for (file in candidates) {
            if (isValidApk(file, versionCode)) {
                return file
            }
        }
        return null
    }

    private fun isValidApk(file: File, versionCode: Int): Boolean {
        if (!file.isFile || file.length() <= 0L) {
            return false
        }
        val info = try {
            packageManager.getPackageArchiveInfo(file.absolutePath, 0)
        } catch (e: Exception) {
            null
        } ?: return false
        return info.packageName == packageName && archiveVersionCode(info) == versionCode.toLong()
    }

    /**
     * 0.3.4 §A：DownloadManager 成功时给出它**实际**写入的 URI。
     * file:// 直接取文件；content://（多数 ROM 走这条）复制到 cacheDir/updates 再走
     * 同一套校验。两条路径都在 file_paths.xml 里声明，FileProvider 都能共享。
     */
    private fun apkFromLocalUri(localUri: String?): File? {
        val raw = localUri?.trim()
        if (raw.isNullOrEmpty()) {
            return externalApkFile(expectedApkName)
        }
        val uri = Uri.parse(raw)
        if (uri.scheme == "file") {
            val path = uri.path
            return if (path.isNullOrEmpty()) null else File(path)
        }
        return copyToCache(uri)
    }

    private fun copyToCache(uri: Uri): File? {
        val dir = File(cacheDir, CACHE_UPDATES_DIR)
        if (!dir.isDirectory && !dir.mkdirs()) {
            return null
        }
        val target = File(dir, expectedApkName)
        return try {
            val input = contentResolver.openInputStream(uri) ?: return null
            input.use { source ->
                target.outputStream().use { sink -> source.copyTo(sink) }
            }
            target
        } catch (e: Exception) {
            target.delete()
            null
        }
    }

    /** 诊断行：DM 状态 / 原因 / 落盘（只显示目录名 + 文件名）。 */
    private fun updateDiag(status: Int, reason: Int, landed: String) {
        if (!::textUpdateDiag.isInitialized) {
            return
        }
        textUpdateDiag.text = getString(R.string.update_diag, status, reason, landed)
        textUpdateDiag.visibility = View.VISIBLE
    }

    private fun landedLabel(file: File): String {
        val parent = file.parentFile?.name ?: "-"
        return parent + "/" + file.name
    }

    private fun verifyAndInstall(file: File) {
        if (!file.isFile) {
            finishDownloadWithFailure()
            return
        }
        val info = packageManager.getPackageArchiveInfo(file.absolutePath, 0)
        val packageMatches = info?.packageName == packageName
        val versionMatches = info != null && archiveVersionCode(info) == expectedVersionCode.toLong()
        if (!packageMatches || !versionMatches) {
            // 校验失败：删掉文件，避免留下坏包。
            file.delete()
            downloadId = -1L
            resetDownloadUi()
            textUpdateStatus.visibility = View.VISIBLE
            textUpdateStatus.text = getString(R.string.update_verify_failed)
            return
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O &&
            !packageManager.canRequestPackageInstalls()
        ) {
            // 0.3.4 §D：先记住这个已校验的包，用户从设置页回来由 onResume 续装一次。
            pendingApk = file
            pendingInstallArmed = true
            textUpdateStatus.visibility = View.VISIBLE
            textUpdateStatus.text = getString(R.string.update_need_permission)
            Toast.makeText(this, R.string.update_need_permission, Toast.LENGTH_LONG).show()
            try {
                startActivity(
                    Intent(
                        Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES,
                        Uri.parse("package:" + packageName)
                    )
                )
            } catch (e: Exception) {
                // 个别 ROM 没有这个设置页；错误已提示，不崩。
            }
            downloadId = -1L
            resetDownloadUi()
            return
        }
        pendingApk = null
        pendingInstallArmed = false
        installApk(file)
    }

    private fun installApk(file: File) {
        val authority = packageName + ".fileprovider"
        val uri = try {
            FileProvider.getUriForFile(this, authority, file)
        } catch (e: Exception) {
            finishDownloadWithFailure()
            return
        }
        val intent = Intent(Intent.ACTION_VIEW).apply {
            setDataAndType(uri, INSTALL_MIME)
            addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_ACTIVITY_NEW_TASK)
        }
        try {
            startActivity(intent)
            Toast.makeText(this, R.string.update_install_started, Toast.LENGTH_SHORT).show()
        } catch (e: Exception) {
            textUpdateStatus.visibility = View.VISIBLE
            textUpdateStatus.text = getString(R.string.update_need_permission)
        }
        downloadId = -1L
        resetDownloadUi()
    }

    @Suppress("DEPRECATION")
    private fun archiveVersionCode(info: android.content.pm.PackageInfo): Long =
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
            info.longVersionCode
        } else {
            info.versionCode.toLong()
        }

    @Suppress("DEPRECATION")
    private fun currentVersionCode(): Long {
        val info = packageManager.getPackageInfo(packageName, 0)
        return if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
            info.longVersionCode
        } else {
            info.versionCode.toLong()
        }
    }

    /**
     * 0.3.4 §D：从「安装未知应用」设置页返回后，若本次会话还留着已校验的包，
     * 自动续装一次。未授权时保留待装状态，不重复弹安装器；装完即清。
     */
    private fun resumePendingInstall() {
        if (!pendingInstallArmed) {
            return
        }
        val file = pendingApk ?: return
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O &&
            !packageManager.canRequestPackageInstalls()
        ) {
            return
        }
        pendingInstallArmed = false
        pendingApk = null
        if (isValidApk(file, expectedVersionCode)) {
            verifyAndInstall(file)
        } else {
            file.delete()
            finishDownloadWithFailure()
        }
    }

    override fun onResume() {
        super.onResume()
        // 从网页登录 / 退出后回到这里：状态立刻跟着变，并让卡片取一次新数据。
        renderWidgetState()
        WidgetScheduler.refreshNow(this)
        // 0.3.4 §D：从「安装未知应用」设置页回来且已授权时，自动续装一次。
        resumePendingInstall()
    }

    override fun onDestroy() {
        handler.removeCallbacksAndMessages(null)
        super.onDestroy()
    }

    // ---- 清除 Cookie 与缓存 ----------------------------------------------

    private fun clearCookiesAndCache() {
        try {
            CookieManager.getInstance().removeAllCookies(null)
            CookieManager.getInstance().flush()
            WebStorage.getInstance().deleteAllData()
            // 用一个临时 WebView 清 HTTP 缓存；用完立刻销毁，避免长期持有。
            val probe = WebView(applicationContext)
            probe.clearCache(true)
            probe.destroy()
            cacheDir?.let { deleteRecursively(it) }
        } catch (e: Exception) {
            // 清缓存失败不影响返回地址页。
        }
    }

    private fun deleteRecursively(file: File) {
        try {
            if (file.isDirectory) {
                file.listFiles()?.forEach { deleteRecursively(it) }
            }
            file.delete()
        } catch (e: Exception) {
            // 忽略单个文件删除失败。
        }
    }
}
