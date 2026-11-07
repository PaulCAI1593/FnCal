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
import androidx.core.content.FileProvider
import java.io.File
import kotlin.concurrent.thread

/**
 * 关于页：应用版本、服务器版本、当前地址、修改地址、清除 Cookie 与缓存，
 * 以及 0.2.0 新增的「检查更新」（范围文档 §B4）。
 *
 * 更新流程：点按钮 → 后台取清单（国内源失败自动改试直通）→ versionCode 更大才提示
 * → 用户确认 → 系统 DownloadManager 下载到外部私有目录 FnCal/updates → 校验包名与
 * versionCode → ACTION_VIEW 交给系统安装器。未点按钮时没有任何网络请求。
 */
class AboutActivity : AppCompatActivity() {

    companion object {
        /** 下载进度的轮询间隔；DownloadManager 没有回调接口，只能 query。 */
        private const val POLL_INTERVAL_MS = 500L
        private const val INSTALL_MIME = "application/vnd.android.package-archive"
    }

    private lateinit var radioSourceCn: RadioButton
    private lateinit var radioSourceDirect: RadioButton
    private lateinit var buttonCheckUpdate: Button
    private lateinit var progressUpdate: ProgressBar
    private lateinit var textUpdateStatus: TextView
    private lateinit var buttonCancelUpdate: Button

    private val handler = Handler(Looper.getMainLooper())
    private var downloadId = -1L
    private var expectedVersionCode = 0
    private var expectedApkName = ""
    private var polling = false

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_about)
        // 0.2.0：与地址页同一套深色蓝绿渐变 + 毛玻璃。
        GlassSurface.applyWindow(this)
        GlassSurface.installBlurLayer(this)

        val appVersion = try {
            packageManager.getPackageInfo(packageName, 0).versionName.orEmpty()
        } catch (e: Exception) {
            BuildConfig.VERSION_NAME
        }
        findViewById<TextView>(R.id.text_app_version).text = appVersion
        findViewById<TextView>(R.id.text_server_version).text =
            ShellPrefs.serverVersion(this) ?: getString(R.string.about_server_version_unknown)
        findViewById<TextView>(R.id.text_address).text = ShellPrefs.baseUrl(this) ?: "-"

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
    }

    // ---- 检查更新（§B4） -------------------------------------------------

    private fun setupUpdateCard() {
        radioSourceCn = findViewById(R.id.radio_source_cn)
        radioSourceDirect = findViewById(R.id.radio_source_direct)
        buttonCheckUpdate = findViewById(R.id.btn_check_update)
        progressUpdate = findViewById(R.id.progress_update)
        textUpdateStatus = findViewById(R.id.text_update_status)
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
            if (source == UpdateSources.Source.DIRECT) {
                R.string.update_source_direct
            } else {
                R.string.update_source_cn
            }
        )

    private fun startDownload(manifest: UpdateChecker.Manifest, source: UpdateSources.Source) {
        val manager = getSystemService(Context.DOWNLOAD_SERVICE) as DownloadManager
        expectedVersionCode = manifest.versionCode
        expectedApkName = manifest.apk
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
                "FnCal/updates/" + manifest.apk
            )
            .setAllowedOverMetered(true)
        downloadId = try {
            manager.enqueue(request)
        } catch (e: Exception) {
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
            when (status) {
                DownloadManager.STATUS_SUCCESSFUL -> {
                    progressUpdate.progress = 100
                    textUpdateStatus.text = getString(R.string.update_verify)
                    verifyAndInstall()
                }

                DownloadManager.STATUS_FAILED -> finishDownloadWithFailure()

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
                    pollDownload()
                }
            }
        }
    }

    private fun finishDownloadWithFailure() {
        downloadId = -1L
        resetDownloadUi()
        textUpdateStatus.visibility = View.VISIBLE
        textUpdateStatus.text = getString(R.string.update_download_failed)
    }

    private fun resetDownloadUi() {
        progressUpdate.visibility = View.GONE
        buttonCancelUpdate.visibility = View.GONE
        buttonCheckUpdate.isEnabled = true
        buttonCheckUpdate.setText(R.string.check_update)
    }

    private fun downloadedApkFile(): File? {
        val dir = getExternalFilesDir(Environment.DIRECTORY_DOWNLOADS) ?: return null
        return File(File(dir, "FnCal/updates"), expectedApkName)
    }

    private fun verifyAndInstall() {
        val file = downloadedApkFile()
        if (file == null || !file.isFile) {
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
            // 没有「安装未知应用」权限：先带去系统设置页。
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
