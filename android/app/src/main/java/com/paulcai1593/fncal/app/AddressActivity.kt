package com.paulcai1593.fncal.app

import android.content.Intent
import android.os.Bundle
import android.view.View
import android.view.inputmethod.EditorInfo
import android.widget.Button
import android.widget.EditText
import android.widget.ProgressBar
import android.widget.TextView
import androidx.appcompat.app.AppCompatActivity
import androidx.appcompat.widget.SwitchCompat
import org.json.JSONObject
import java.net.ConnectException
import java.net.HttpURLConnection
import java.net.SocketTimeoutException
import java.net.URL
import java.net.UnknownHostException
import java.security.cert.X509Certificate
import javax.net.ssl.HostnameVerifier
import javax.net.ssl.HttpsURLConnection
import javax.net.ssl.SSLContext
import javax.net.ssl.SSLException
import javax.net.ssl.X509TrustManager
import kotlin.concurrent.thread

/**
 * 地址页：首次打开填自托管地址；从「关于 → 修改地址」进来时预填旧地址。
 *
 * 流程：输入 → UrlNormalizer 规范化 → GET {base}/api/health（10 秒超时）
 * → ok:true 就存地址与服务器版本并进主界面；失败给中文原因和「仍然打开」。
 */
class AddressActivity : AppCompatActivity() {

    companion object {
        /** 从「关于」页进来时置 true：不自动跳主界面，显示表单让用户改。 */
        const val EXTRA_EDIT = "edit"

        private const val PROBE_TIMEOUT_MS = 10_000
    }

    private enum class FailKind { CERT, TIMEOUT, REFUSED, NOT_FNCAL, HTTP, OTHER }

    private sealed class Outcome {
        data class Success(val version: String) : Outcome()
        data class Failure(val kind: FailKind, val status: Int = 0) : Outcome()
    }

    private lateinit var input: EditText
    private lateinit var errorText: TextView
    private lateinit var buttonConnect: Button
    private lateinit var buttonOpenAnyway: Button
    private lateinit var progress: ProgressBar
    private lateinit var switchSelfSigned: SwitchCompat

    private var busy = false
    private var pendingUrl: String? = null

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        val editMode = intent.getBooleanExtra(EXTRA_EDIT, false)
        val saved = ShellPrefs.baseUrl(this)
        if (!editMode && !saved.isNullOrBlank()) {
            openMain(saved)
            return
        }

        setContentView(R.layout.activity_address)
        input = findViewById(R.id.input_address)
        errorText = findViewById(R.id.text_error)
        buttonConnect = findViewById(R.id.btn_connect)
        buttonOpenAnyway = findViewById(R.id.btn_open_anyway)
        progress = findViewById(R.id.progress_connect)
        switchSelfSigned = findViewById(R.id.switch_self_signed)

        input.setText(saved ?: "http://")
        input.setSelection(input.text.length)
        switchSelfSigned.isChecked = ShellPrefs.allowSelfSigned(this)

        buttonConnect.setOnClickListener { onConnectClicked() }
        buttonOpenAnyway.setOnClickListener { onOpenAnywayClicked() }
        input.setOnEditorActionListener { _, actionId, _ ->
            if (actionId == EditorInfo.IME_ACTION_GO) {
                onConnectClicked()
                true
            } else {
                false
            }
        }
    }

    private fun onConnectClicked() {
        if (busy) return
        val normalized = UrlNormalizer.normalize(input.text.toString())
        if (!normalized.ok || normalized.url == null) {
            showInputError(normalized.error)
            return
        }
        pendingUrl = normalized.url
        clearInputError()
        setBusy(true)
        probe(normalized.url, switchSelfSigned.isChecked)
    }

    private fun onOpenAnywayClicked() {
        val url = pendingUrl ?: return
        ShellPrefs.setBaseUrl(this, url)
        ShellPrefs.setAllowSelfSigned(this, switchSelfSigned.isChecked)
        openMain(url)
    }

    private fun probe(baseUrl: String, allowSelfSigned: Boolean) {
        thread(name = "fncal-health") {
            val outcome = try {
                val url = URL(baseUrl + "/api/health")
                val connection = url.openConnection() as HttpURLConnection
                connection.connectTimeout = PROBE_TIMEOUT_MS
                connection.readTimeout = PROBE_TIMEOUT_MS
                connection.requestMethod = "GET"
                connection.setRequestProperty("Accept", "application/json")
                if (allowSelfSigned && connection is HttpsURLConnection) {
                    connection.sslSocketFactory = trustAllContext().socketFactory as javax.net.ssl.SSLSocketFactory
                    connection.hostnameVerifier = HostnameVerifier { _, _ -> true }
                }
                try {
                    val status = connection.responseCode
                    if (status !in 200..299) {
                        Outcome.Failure(FailKind.HTTP, status)
                    } else {
                        val body = connection.inputStream
                            ?.bufferedReader()
                            ?.use { it.readText() }
                            .orEmpty()
                        parseHealth(body)
                    }
                } finally {
                    connection.disconnect()
                }
            } catch (e: SSLException) {
                Outcome.Failure(FailKind.CERT)
            } catch (e: SocketTimeoutException) {
                Outcome.Failure(FailKind.TIMEOUT)
            } catch (e: ConnectException) {
                Outcome.Failure(FailKind.REFUSED)
            } catch (e: UnknownHostException) {
                Outcome.Failure(FailKind.REFUSED)
            } catch (e: Exception) {
                Outcome.Failure(FailKind.OTHER)
            }

            runOnUiThread {
                if (isFinishing || isDestroyed) return@runOnUiThread
                applyOutcome(baseUrl, outcome)
            }
        }
    }

    private fun parseHealth(body: String): Outcome {
        return try {
            val json = JSONObject(body)
            if (json.optBoolean("ok", false)) {
                Outcome.Success(json.optString("version", ""))
            } else {
                Outcome.Failure(FailKind.NOT_FNCAL)
            }
        } catch (e: Exception) {
            Outcome.Failure(FailKind.NOT_FNCAL)
        }
    }

    private fun applyOutcome(baseUrl: String, outcome: Outcome) {
        if (isFinishing) return
        when (outcome) {
            is Outcome.Success -> {
                ShellPrefs.setBaseUrl(this, baseUrl)
                ShellPrefs.setServerVersion(this, outcome.version)
                ShellPrefs.setAllowSelfSigned(this, switchSelfSigned.isChecked)
                setBusy(false)
                openMain(baseUrl)
            }

            is Outcome.Failure -> {
                setBusy(false)
                errorText.text = failureMessage(outcome)
                errorText.visibility = View.VISIBLE
                buttonOpenAnyway.visibility = View.VISIBLE
            }
        }
    }

    private fun failureMessage(outcome: Outcome.Failure): String = when (outcome.kind) {
        FailKind.CERT -> getString(R.string.fail_cert)
        FailKind.TIMEOUT -> getString(R.string.fail_timeout)
        FailKind.REFUSED -> getString(R.string.fail_refused)
        FailKind.NOT_FNCAL -> getString(R.string.fail_not_fncal)
        FailKind.HTTP -> getString(R.string.fail_http, outcome.status)
        FailKind.OTHER -> getString(R.string.fail_other)
    }

    private fun showInputError(error: UrlNormalizer.Error?) {
        val message = when (error) {
            UrlNormalizer.Error.EMPTY -> R.string.error_empty
            UrlNormalizer.Error.WHITESPACE -> R.string.error_whitespace
            UrlNormalizer.Error.NON_ASCII -> R.string.error_non_ascii
            UrlNormalizer.Error.BAD_SCHEME -> R.string.error_bad_scheme
            UrlNormalizer.Error.NO_HOST -> R.string.error_no_host
            UrlNormalizer.Error.INVALID, null -> R.string.error_invalid
        }
        errorText.text = getString(message)
        errorText.visibility = View.VISIBLE
        buttonOpenAnyway.visibility = View.GONE
    }

    private fun clearInputError() {
        errorText.visibility = View.GONE
        buttonOpenAnyway.visibility = View.GONE
    }

    private fun setBusy(value: Boolean) {
        busy = value
        buttonConnect.isEnabled = !value
        buttonConnect.text = getString(if (value) R.string.connecting else R.string.connect)
        switchSelfSigned.isEnabled = !value
        input.isEnabled = !value
        progress.visibility = if (value) View.VISIBLE else View.GONE
    }

    private fun openMain(baseUrl: String) {
        val intent = Intent(this, MainActivity::class.java)
        intent.flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TASK
        startActivity(intent)
        finish()
    }

    /** 自签证书时探活也放行——否则「允许自签」只对 WebView 生效，探活仍然失败。 */
    private fun trustAllContext(): SSLContext {
        val trustAll = object : X509TrustManager {
            override fun checkClientTrusted(chain: Array<out X509Certificate>?, authType: String?) = Unit
            override fun checkServerTrusted(chain: Array<out X509Certificate>?, authType: String?) = Unit
            override fun getAcceptedIssuers(): Array<X509Certificate> = emptyArray()
        }
        val context = SSLContext.getInstance("TLS")
        context.init(null, arrayOf(trustAll), null)
        return context
    }
}
