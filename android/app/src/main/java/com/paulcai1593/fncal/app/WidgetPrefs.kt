package com.paulcai1593.fncal.app

import android.content.Context
import android.content.SharedPreferences
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/**
 * 0.3.0 桌面卡片的本地存储（范围文档 A1/A2）。
 *
 * - 令牌用 Android Keystore 的 AES/GCM 加密后存 SharedPreferences：明文不落盘、
 *   不进日志；密钥不出 Keystore（不可导出）。
 * - 缓存只存最近一次成功的摘要 JSON 与它的 ETag/时间；网络失败时卡片继续用缓存，
 *   并显示「上次更新 HH:mm」。
 * - 解密失败（例如系统换了密钥、恢复备份）按「没有令牌」处理，不崩、不反复重试。
 */
object WidgetPrefs {

    private const val FILE = "fncal_widget"
    private const val KEY_TOKEN = "token_enc"
    private const val KEY_CACHE = "cache_json"
    private const val KEY_ETAG = "cache_etag"
    private const val KEY_UPDATED = "last_updated"
    private const val KEY_ERROR = "last_error"

    private const val KEYSTORE = "AndroidKeyStore"
    private const val ALIAS = "fncal_widget_token"
    private const val TRANSFORM = "AES/GCM/NoPadding"
    private const val IV_BYTES = 12
    private const val TAG_BITS = 128

    private fun prefs(context: Context): SharedPreferences =
        context.applicationContext.getSharedPreferences(FILE, Context.MODE_PRIVATE)

    private fun secretKey(): SecretKey {
        val store = KeyStore.getInstance(KEYSTORE).apply { load(null) }
        val existing = store.getEntry(ALIAS, null) as? KeyStore.SecretKeyEntry
        if (existing != null) return existing.secretKey
        val generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, KEYSTORE)
        generator.init(
            KeyGenParameterSpec.Builder(
                ALIAS,
                KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT
            )
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setKeySize(256)
                .build()
        )
        return generator.generateKey()
    }

    private fun encrypt(plain: String): String? = try {
        val cipher = Cipher.getInstance(TRANSFORM)
        cipher.init(Cipher.ENCRYPT_MODE, secretKey())
        val iv = cipher.iv
        val body = cipher.doFinal(plain.toByteArray(Charsets.UTF_8))
        val packed = ByteArray(iv.size + body.size)
        System.arraycopy(iv, 0, packed, 0, iv.size)
        System.arraycopy(body, 0, packed, iv.size, body.size)
        Base64.encodeToString(packed, Base64.NO_WRAP)
    } catch (e: Exception) {
        null
    }

    private fun decrypt(stored: String): String? = try {
        val packed = Base64.decode(stored, Base64.NO_WRAP)
        if (packed.size <= IV_BYTES) {
            null
        } else {
            val iv = packed.copyOfRange(0, IV_BYTES)
            val body = packed.copyOfRange(IV_BYTES, packed.size)
            val cipher = Cipher.getInstance(TRANSFORM)
            cipher.init(Cipher.DECRYPT_MODE, secretKey(), GCMParameterSpec(TAG_BITS, iv))
            String(cipher.doFinal(body), Charsets.UTF_8)
        }
    } catch (e: Exception) {
        null
    }

    fun hasToken(context: Context): Boolean = token(context) != null

    fun token(context: Context): String? {
        val stored = prefs(context).getString(KEY_TOKEN, null)
        if (stored.isNullOrBlank()) return null
        return decrypt(stored)?.takeIf { it.isNotBlank() }
    }

    fun setToken(context: Context, token: String?) {
        val editor = prefs(context).edit()
        if (token.isNullOrBlank()) {
            editor.remove(KEY_TOKEN)
        } else {
            val encrypted = encrypt(token)
            if (encrypted == null) {
                editor.remove(KEY_TOKEN)
            } else {
                editor.putString(KEY_TOKEN, encrypted)
            }
        }
        editor.apply()
    }

    fun cache(context: Context): String? = prefs(context).getString(KEY_CACHE, null)

    fun etag(context: Context): String? = prefs(context).getString(KEY_ETAG, null)

    fun lastUpdated(context: Context): Long = prefs(context).getLong(KEY_UPDATED, 0L)

    fun lastError(context: Context): String? = prefs(context).getString(KEY_ERROR, null)

    /** 200：换掉缓存与 ETag，并记下本次成功时间。 */
    fun saveSuccess(context: Context, json: String, etag: String?, at: Long) {
        val editor = prefs(context).edit()
        editor.putString(KEY_CACHE, json)
        if (etag.isNullOrBlank()) editor.remove(KEY_ETAG) else editor.putString(KEY_ETAG, etag)
        editor.putLong(KEY_UPDATED, at)
        editor.remove(KEY_ERROR)
        editor.apply()
    }

    /** 304：内容没变，只更新时间、清掉上次错误。 */
    fun saveNotModified(context: Context, at: Long) {
        prefs(context).edit()
            .putLong(KEY_UPDATED, at)
            .remove(KEY_ERROR)
            .apply()
    }

    /** 失败：保留缓存，只记错误原因（卡片据此显示上次更新时间）。 */
    fun saveError(context: Context, message: String?) {
        prefs(context).edit().putString(KEY_ERROR, message ?: "").apply()
    }

    fun clear(context: Context) {
        prefs(context).edit().clear().apply()
    }
}
