package app.atlas.android

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/**
 * The device token. An AES-256-GCM key that never leaves the Android Keystore (hardware-backed where the phone has it) encrypts the
 * token; only the ciphertext (IV + data) is stored, in app-private SharedPreferences. There is no plaintext fallback: when the
 * Keystore fails, the token is not stored and the app says so. `allowBackup` is off, so neither the key nor the ciphertext is backed up.
 */
class SecureToken(context: Context) {
  private val prefs = context.applicationContext.getSharedPreferences("atlas_secure", Context.MODE_PRIVATE)
  private val alias = "atlas-device-token-v1"

  private fun key(): SecretKey {
    val ks = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
    (ks.getKey(alias, null) as? SecretKey)?.let { return it }
    val gen = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore")
    gen.init(
      KeyGenParameterSpec.Builder(alias, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
        .setBlockModes(KeyProperties.BLOCK_MODE_GCM).setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE).setKeySize(256).build()
    )
    return gen.generateKey()
  }

  fun set(token: String) {
    val c = Cipher.getInstance("AES/GCM/NoPadding")
    c.init(Cipher.ENCRYPT_MODE, key())
    val ct = c.doFinal(token.toByteArray(Charsets.UTF_8))
    val blob = Base64.encodeToString(c.iv, Base64.NO_WRAP) + ":" + Base64.encodeToString(ct, Base64.NO_WRAP)
    if (!prefs.edit().putString("token", blob).commit()) throw IllegalStateException("could not persist")
  }

  fun get(): String? {
    val blob = prefs.getString("token", null) ?: return null
    val (iv, ct) = blob.split(":").let { it[0] to it[1] }
    val c = Cipher.getInstance("AES/GCM/NoPadding")
    c.init(Cipher.DECRYPT_MODE, key(), GCMParameterSpec(128, Base64.decode(iv, Base64.NO_WRAP)))
    return String(c.doFinal(Base64.decode(ct, Base64.NO_WRAP)), Charsets.UTF_8)
  }

  fun delete() {
    prefs.edit().remove("token").commit()
    runCatching { KeyStore.getInstance("AndroidKeyStore").apply { load(null) }.deleteEntry(alias) }
  }
}
