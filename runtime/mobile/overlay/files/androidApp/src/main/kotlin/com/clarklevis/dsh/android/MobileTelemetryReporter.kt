package com.clarklevis.dsh.android

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import com.clarklevis.dsh.android.telemetry.MobileTelemetry
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/**
 * 把手机遥测接到应用生命周期上。
 *
 * 职责有三件：从配对得到的设备令牌与地址建立上报器、记录启动与连接结果、在退到后台时
 * 把队列刷出去。所有失败都静默，遥测不能影响连接与界面。
 *
 * 令牌保存在 Android Keystore 加密的独立存储里，明文不落盘、不进日志。
 */
internal object MobileTelemetryReporter {
    private const val PREFERENCES = "mobile-telemetry"
    private const val KEY_BASE_URL = "base-url"
    private const val KEY_TOKEN_CIPHERTEXT = "token-ciphertext"
    private const val KEYSTORE = "AndroidKeyStore"
    private const val KEY_ALIAS = "chatdsh-mobile-telemetry"
    private const val TRANSFORMATION = "AES/GCM/NoPadding"

    @Volatile
    private var reporter: MobileTelemetry? = null

    /** 配对成功后调用：保存地址与令牌，并重建上报器。 */
    internal fun onPaired(context: Context, baseUrl: String, token: String) {
        runCatching {
            val preferences = context.getSharedPreferences(PREFERENCES, Context.MODE_PRIVATE)
            preferences.edit()
                .putString(KEY_BASE_URL, baseUrl)
                .putString(KEY_TOKEN_CIPHERTEXT, encrypt(token))
                .apply()
            reporter = MobileTelemetry(baseUrl, token)
        }
    }

    /** 应用启动时调用：有保存的凭据就建立上报器并记一条启动信号。 */
    internal fun onApplicationStart(context: Context) {
        runCatching {
            val preferences = context.getSharedPreferences(PREFERENCES, Context.MODE_PRIVATE)
            val baseUrl = preferences.getString(KEY_BASE_URL, null) ?: return
            val token = preferences.getString(KEY_TOKEN_CIPHERTEXT, null)?.let(::decrypt) ?: return
            val instrument = reporter ?: MobileTelemetry(baseUrl, token).also { reporter = it }
            instrument.startup("cold")
            instrument.flush()
        }
    }

    /** 一次连接尝试结束时调用。 */
    internal fun onConnectAttempt(attempt: Int, outcome: String, durationMs: Long) {
        val instrument = reporter ?: return
        instrument.connect(attempt, outcome, durationMs)
        instrument.flush()
    }

    /** 凭据读写时调用。 */
    internal fun onKeystore(action: String, outcome: String) {
        reporter?.keystore(action, outcome)
    }

    /** 退到后台时把队列刷出去。 */
    internal fun onApplicationBackground(context: Context, scope: kotlinx.coroutines.CoroutineScope) {
        val instrument = reporter ?: return
        instrument.offlineQueueDepth(0)
        scope.launch(Dispatchers.IO) {
            // 给一次短延迟，让刚产生的记录进入同一批。
            delay(200)
            withContext(Dispatchers.IO) { instrument.flush() }
        }
    }

    private fun encrypt(value: String): String {
        val cipher = Cipher.getInstance(TRANSFORMATION)
        cipher.init(Cipher.ENCRYPT_MODE, loadOrCreateKey())
        val ciphertext = cipher.doFinal(value.toByteArray(Charsets.UTF_8))
        return Base64.encodeToString(cipher.iv + ciphertext, Base64.NO_WRAP)
    }

    private fun decrypt(encoded: String): String? = runCatching {
        val payload = Base64.decode(encoded, Base64.NO_WRAP)
        val iv = payload.copyOfRange(0, IV_BYTES)
        val ciphertext = payload.copyOfRange(IV_BYTES, payload.size)
        val cipher = Cipher.getInstance(TRANSFORMATION)
        cipher.init(Cipher.DECRYPT_MODE, loadOrCreateKey(), GCMParameterSpec(TAG_BITS, iv))
        cipher.doFinal(ciphertext).toString(Charsets.UTF_8)
    }.getOrNull()

    private fun loadOrCreateKey(): SecretKey {
        val keyStore = KeyStore.getInstance(KEYSTORE).apply { load(null) }
        (keyStore.getEntry(KEY_ALIAS, null) as? KeyStore.SecretKeyEntry)?.let { return it.secretKey }
        val generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, KEYSTORE)
        generator.init(
            KeyGenParameterSpec.Builder(KEY_ALIAS, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .build()
        )
        return generator.generateKey()
    }

    private const val IV_BYTES = 12
    private const val TAG_BITS = 128
}
