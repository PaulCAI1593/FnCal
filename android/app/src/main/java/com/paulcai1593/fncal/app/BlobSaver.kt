package com.paulcai1593.fncal.app

import android.content.ContentValues
import android.content.Context
import android.content.pm.PackageManager
import android.media.MediaScannerConnection
import android.os.Build
import android.os.Environment
import android.os.Handler
import android.os.Looper
import android.provider.MediaStore
import android.util.Base64
import android.webkit.JavascriptInterface
import android.widget.Toast
import androidx.core.content.ContextCompat
import java.io.File
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

/**
 * 网页里 Blob 导出（.ics / JSON 备份 / 诊断包）的原生落盘端。
 *
 * 网页注入的 shell.js 把 blob 读成 base64，调用 `FnCalSave.save(name, mime, base64)`；
 * 这里按系统版本写 Downloads/FnCal：
 * - API 29+：MediaStore.Downloads（不需要存储权限）。
 * - API 24–28：公共下载目录 + WRITE_EXTERNAL_STORAGE（清单里限 maxSdkVersion=28）。
 */
class BlobSaver(private val context: Context) {

    private val mainHandler = Handler(Looper.getMainLooper())

    @JavascriptInterface
    fun save(name: String?, mime: String?, base64: String?) {
        val bytes = try {
            Base64.decode(base64 ?: "", Base64.DEFAULT)
        } catch (e: Exception) {
            null
        }
        if (bytes == null || bytes.isEmpty()) {
            toast(R.string.save_failed)
            return
        }

        val safeMime = if (mime.isNullOrBlank()) "application/octet-stream" else mime
        val safeName = sanitizeName(name, safeMime)

        val saved = try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                saveToMediaStore(safeName, safeMime, bytes)
            } else {
                saveToPublicDownloads(safeName, bytes)
            }
        } catch (e: Exception) {
            false
        }

        toast(if (saved) R.string.save_done else R.string.save_failed)
    }

    @androidx.annotation.RequiresApi(Build.VERSION_CODES.Q)
    private fun saveToMediaStore(name: String, mime: String, bytes: ByteArray): Boolean {
        val resolver = context.contentResolver
        val values = ContentValues().apply {
            put(MediaStore.MediaColumns.DISPLAY_NAME, name)
            put(MediaStore.MediaColumns.MIME_TYPE, mime)
            put(
                MediaStore.MediaColumns.RELATIVE_PATH,
                Environment.DIRECTORY_DOWNLOADS + File.separator + SUB_DIR,
            )
            put(MediaStore.MediaColumns.IS_PENDING, 1)
        }
        val uri = resolver.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values) ?: return false
        val stream = try {
            resolver.openOutputStream(uri)
        } catch (e: Exception) {
            null
        }
        if (stream == null) {
            resolver.delete(uri, null, null)
            return false
        }
        return try {
            stream.use { it.write(bytes) }
            val done = ContentValues().apply {
                put(MediaStore.MediaColumns.IS_PENDING, 0)
            }
            resolver.update(uri, done, null, null)
            true
        } catch (e: Exception) {
            resolver.delete(uri, null, null)
            false
        }
    }

    private fun saveToPublicDownloads(name: String, bytes: ByteArray): Boolean {
        val granted = ContextCompat.checkSelfPermission(
            context,
            android.Manifest.permission.WRITE_EXTERNAL_STORAGE,
        ) == PackageManager.PERMISSION_GRANTED
        if (!granted) return false

        @Suppress("DEPRECATION")
        val downloads = Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOWNLOADS)
        val dir = File(downloads, SUB_DIR)
        if (!dir.exists() && !dir.mkdirs()) return false
        val file = File(dir, name)
        file.writeBytes(bytes)
        MediaScannerConnection.scanFile(context, arrayOf(file.absolutePath), null, null)
        return true
    }

    private fun sanitizeName(raw: String?, mime: String): String {
        val fallbackBase = "FnCal-" + SimpleDateFormat("yyyyMMdd-HHmmss", Locale.US).format(Date())
        var name = raw?.trim().orEmpty()
        if (name.isEmpty()) name = fallbackBase + extensionFor(mime)

        // 去掉路径成分与非法字符，避免写到目标目录之外。
        name = name.replace('\\', '/').substringAfterLast('/')
        name = name.replace(Regex("[\\u0000-\\u001F:*?\"<>|]"), "_")
        name = name.replace(Regex("\\s+"), " ").trim().trim('.')
        if (name.isEmpty()) name = fallbackBase + extensionFor(mime)

        val hasExtension = name.substringAfterLast('.', "").length in 1..8
        if (!hasExtension) name += extensionFor(mime)
        if (name.length > 120) {
            val ext = extensionFor(mime)
            name = name.take(120 - ext.length) + ext
        }
        return name
    }

    private fun extensionFor(mime: String): String = when {
        mime.contains("calendar") -> ".ics"
        mime.contains("json") -> ".json"
        mime.contains("zip") -> ".zip"
        mime.contains("pdf") -> ".pdf"
        mime.startsWith("text/") -> ".txt"
        else -> ".bin"
    }

    private fun toast(resId: Int) {
        mainHandler.post {
            Toast.makeText(context, resId, Toast.LENGTH_LONG).show()
        }
    }

    private companion object {
        const val SUB_DIR = "FnCal"
    }
}
