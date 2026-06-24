package dev.revivalside.capture.android

import android.content.Context

internal data class AndroidRuntimeSnapshot(
    val listenerRunning: Boolean,
    val listenerMessage: String,
    val vpnRunning: Boolean,
    val vpnMode: String,
    val vpnMessage: String,
)

internal object AndroidRuntimeState {
    private const val PREFS = "revivalside_runtime_state"
    private const val KEY_LISTENER_RUNNING = "listener_running"
    private const val KEY_LISTENER_MESSAGE = "listener_message"
    private const val KEY_VPN_RUNNING = "vpn_running"
    private const val KEY_VPN_MODE = "vpn_mode"
    private const val KEY_VPN_MESSAGE = "vpn_message"

    fun writeListener(context: Context, running: Boolean, message: String) {
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
            .edit()
            .putBoolean(KEY_LISTENER_RUNNING, running)
            .putString(KEY_LISTENER_MESSAGE, message)
            .apply()
    }

    fun writeVpn(context: Context, running: Boolean, mode: String, message: String) {
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
            .edit()
            .putBoolean(KEY_VPN_RUNNING, running)
            .putString(KEY_VPN_MODE, mode)
            .putString(KEY_VPN_MESSAGE, message)
            .apply()
    }

    fun snapshot(context: Context): AndroidRuntimeSnapshot {
        val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        return AndroidRuntimeSnapshot(
            listenerRunning = prefs.getBoolean(KEY_LISTENER_RUNNING, false),
            listenerMessage = prefs.getString(KEY_LISTENER_MESSAGE, "Idle") ?: "Idle",
            vpnRunning = prefs.getBoolean(KEY_VPN_RUNNING, false),
            vpnMode = prefs.getString(KEY_VPN_MODE, "") ?: "",
            vpnMessage = prefs.getString(KEY_VPN_MESSAGE, "VPN idle") ?: "VPN idle",
        )
    }
}
