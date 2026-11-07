package com.paulcai1593.fncal.app

import android.content.Intent
import android.os.Bundle
import android.webkit.CookieManager
import android.webkit.WebStorage
import android.webkit.WebView
import android.widget.Button
import android.widget.TextView
import android.widget.Toast
import androidx.appcompat.app.AppCompatActivity
import java.io.File

/**
 * 关于页：应用版本、服务器版本、当前地址、修改地址、清除 Cookie 与缓存。
 * 入口是主界面右上角菜单「关于」。
 */
class AboutActivity : AppCompatActivity() {

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_about)

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
    }

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
