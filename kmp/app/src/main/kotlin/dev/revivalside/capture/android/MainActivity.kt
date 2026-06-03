package dev.revivalside.capture.android

import android.Manifest
import android.app.Activity
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.PackageManager
import android.net.Uri
import android.net.VpnService
import android.os.Build
import android.os.Bundle
import android.provider.Settings
import android.view.Gravity
import android.view.View
import android.widget.Button
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import java.io.File
import java.time.LocalTime
import java.time.format.DateTimeFormatter

class MainActivity : Activity() {
    private lateinit var packageInput: EditText
    private lateinit var statusText: TextView
    private lateinit var exportText: TextView
    private lateinit var logText: TextView
    private val timeFormat = DateTimeFormatter.ofPattern("HH:mm:ss")

    private val statusReceiver = object : BroadcastReceiver() {
        override fun onReceive(context: Context, intent: Intent) {
            val message = intent.getStringExtra(CounterSideVpnService.EXTRA_MESSAGE) ?: return
            statusText.text = message
            appendLog(message)
            val exportPath = intent.getStringExtra(CounterSideVpnService.EXTRA_EXPORT_PATH)
            if (!exportPath.isNullOrBlank()) {
                exportText.text = exportPath
            }
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(buildUi())
        requestNotificationPermissionIfNeeded()
        registerStatusReceiver()
        appendLog("Ready")
    }

    override fun onDestroy() {
        unregisterReceiver(statusReceiver)
        super.onDestroy()
    }

    @Deprecated("VPN permission result uses the platform callback for this no-dependency app.")
    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        super.onActivityResult(requestCode, resultCode, data)
        if (requestCode == VPN_REQUEST && resultCode == RESULT_OK) {
            startCaptureService()
        }
    }

    private fun buildUi(): View {
        val root = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(18), dp(18), dp(18), dp(18))
            setBackgroundColor(0xfff6f8fa.toInt())
        }

        root.addView(TextView(this).apply {
            text = "RevivalSide Capture"
            textSize = 24f
            setTextColor(0xff172033.toInt())
        })
        root.addView(TextView(this).apply {
            text = "Capture the Android JOIN_LOBBY_ACK and share a desktop import bundle."
            textSize = 14f
            setTextColor(0xff5f6b7a.toInt())
            setPadding(0, dp(4), 0, dp(14))
        })

        packageInput = EditText(this).apply {
            setSingleLine(true)
            hint = "CounterSide package"
            setText(loadTargetPackage())
        }
        root.addView(label("Target app package"))
        root.addView(packageInput, LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT)

        val buttons = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.START
            setPadding(0, dp(14), 0, dp(14))
        }
        buttons.addView(actionButton("Start") { beginStartFlow() })
        buttons.addView(actionButton("Stop") { stopCaptureService() })
        buttons.addView(actionButton("Share export") { shareLatestExport() })
        root.addView(buttons)

        root.addView(label("Status"))
        statusText = TextView(this).apply {
            text = "Idle"
            textSize = 15f
            setTextColor(0xff166534.toInt())
            setPadding(0, dp(2), 0, dp(10))
        }
        root.addView(statusText)

        root.addView(label("Latest export"))
        exportText = TextView(this).apply {
            text = CaptureRepository.latestExport(this@MainActivity)?.absolutePath ?: "No export yet"
            textSize = 13f
            setTextColor(0xff334155.toInt())
            setPadding(0, dp(2), 0, dp(10))
        }
        root.addView(exportText)

        root.addView(label("Activity"))
        logText = TextView(this).apply {
            textSize = 12f
            setTextColor(0xff0f172a.toInt())
            setPadding(dp(10), dp(8), dp(10), dp(8))
            setBackgroundColor(0xffffffff.toInt())
            typeface = android.graphics.Typeface.MONOSPACE
        }
        val scroll = ScrollView(this).apply {
            addView(logText)
        }
        root.addView(scroll, LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, 0, 1f))
        return root
    }

    private fun beginStartFlow() {
        saveTargetPackage()
        val intent = VpnService.prepare(this)
        if (intent != null) {
            startActivityForResult(intent, VPN_REQUEST)
        } else {
            startCaptureService()
        }
    }

    private fun startCaptureService() {
        val service = Intent(this, CounterSideVpnService::class.java).apply {
            action = CounterSideVpnService.ACTION_START
            putExtra(CounterSideVpnService.EXTRA_TARGET_PACKAGE, loadTargetPackage())
        }
        if (Build.VERSION.SDK_INT >= 26) startForegroundService(service) else startService(service)
        appendLog("Starting capture")
    }

    private fun stopCaptureService() {
        startService(Intent(this, CounterSideVpnService::class.java).apply {
            action = CounterSideVpnService.ACTION_STOP
        })
        appendLog("Stopping capture")
    }

    private fun shareLatestExport() {
        val file = CaptureRepository.latestExport(this)
        if (file == null) {
            appendLog("No export is available yet")
            return
        }
        val uri = Uri.Builder()
            .scheme("content")
            .authority("dev.revivalside.officialprofilecapture.exports")
            .appendPath(file.name)
            .build()
        val share = Intent(Intent.ACTION_SEND).apply {
            type = "application/zip"
            putExtra(Intent.EXTRA_STREAM, uri)
            addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
        }
        startActivity(Intent.createChooser(share, "Share JOIN_LOBBY_ACK bundle"))
    }

    private fun registerStatusReceiver() {
        val filter = IntentFilter(CounterSideVpnService.ACTION_STATUS)
        if (Build.VERSION.SDK_INT >= 33) {
            registerReceiver(statusReceiver, filter, RECEIVER_NOT_EXPORTED)
        } else {
            @Suppress("DEPRECATION")
            registerReceiver(statusReceiver, filter)
        }
    }

    private fun requestNotificationPermissionIfNeeded() {
        if (Build.VERSION.SDK_INT >= 33 && checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
            requestPermissions(arrayOf(Manifest.permission.POST_NOTIFICATIONS), 45)
        }
    }

    private fun saveTargetPackage() {
        getSharedPreferences(PREFS, MODE_PRIVATE)
            .edit()
            .putString(KEY_TARGET_PACKAGE, packageInput.text.toString().trim())
            .apply()
    }

    private fun loadTargetPackage(): String {
        return getSharedPreferences(PREFS, MODE_PRIVATE)
            .getString(KEY_TARGET_PACKAGE, DEFAULT_COUNTERSIDE_PACKAGE)
            ?.ifBlank { DEFAULT_COUNTERSIDE_PACKAGE }
            ?: DEFAULT_COUNTERSIDE_PACKAGE
    }

    private fun appendLog(message: String) {
        val line = "[${LocalTime.now().format(timeFormat)}] $message"
        logText.text = if (logText.text.isNullOrBlank()) line else "${logText.text}\n$line"
    }

    private fun label(text: String): TextView {
        return TextView(this).apply {
            this.text = text
            textSize = 12f
            setTextColor(0xff64748b.toInt())
            setPadding(0, dp(8), 0, 0)
        }
    }

    private fun actionButton(text: String, onClick: () -> Unit): Button {
        return Button(this).apply {
            this.text = text
            setOnClickListener { onClick() }
        }
    }

    private fun dp(value: Int): Int = (value * resources.displayMetrics.density).toInt()

    private companion object {
        const val VPN_REQUEST = 100
        const val PREFS = "revivalside_capture"
        const val KEY_TARGET_PACKAGE = "target_package"
        const val DEFAULT_COUNTERSIDE_PACKAGE = "com.studiobside.CounterSide"
    }
}
