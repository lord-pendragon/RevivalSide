package dev.revivalside.capture.android

import android.content.Context
import dev.revivalside.capture.protocol.CapturedCounterSideFrame
import dev.revivalside.capture.protocol.toLowerHex
import java.io.File
import java.security.MessageDigest
import java.time.Instant
import java.time.ZoneOffset
import java.time.format.DateTimeFormatter
import java.util.zip.ZipEntry
import java.util.zip.ZipOutputStream

internal object CaptureRepository {
    private const val PREFS = "revivalside_capture"
    private const val KEY_LATEST_EXPORT = "latest_export"
    private val stampFormat = DateTimeFormatter.ofPattern("yyyyMMdd-HHmmss").withZone(ZoneOffset.UTC)

    @Synchronized
    fun saveJoinLobbyAck(context: Context, frame: CapturedCounterSideFrame, connectionLabel: String): File {
        val exportDir = File(context.filesDir, "exports")
        exportDir.mkdirs()
        val stamp = stampFormat.format(Instant.now())
        val zipFile = File(exportDir, "join-lobby-ack-$stamp.zip")
        val rawName = "server_001_${frame.packetId}.packet.bin"
        val payloadName = "server_001_${frame.packetId}.payload.bin"
        val manifest = buildManifest(frame, connectionLabel, rawName, payloadName)

        ZipOutputStream(zipFile.outputStream().buffered()).use { zip ->
            zip.putNextEntry(ZipEntry("manifest.json"))
            zip.write(manifest.toByteArray(Charsets.UTF_8))
            zip.closeEntry()

            zip.putNextEntry(ZipEntry(rawName))
            zip.write(frame.raw)
            zip.closeEntry()

            zip.putNextEntry(ZipEntry(payloadName))
            zip.write(frame.payload)
            zip.closeEntry()
        }

        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
            .edit()
            .putString(KEY_LATEST_EXPORT, zipFile.absolutePath)
            .apply()
        return zipFile
    }

    fun latestExport(context: Context): File? {
        val path = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getString(KEY_LATEST_EXPORT, "") ?: ""
        val file = File(path)
        return file.takeIf { path.isNotBlank() && it.isFile }
    }

    private fun buildManifest(
        frame: CapturedCounterSideFrame,
        connectionLabel: String,
        rawName: String,
        payloadName: String,
    ): String {
        val sha256 = MessageDigest.getInstance("SHA-256").digest(frame.raw).toLowerHex()
        val escapedConnection = connectionLabel.replace("\\", "\\\\").replace("\"", "\\\"")
        return """
            {
              "source": "android-vpn",
              "capturedAt": "${Instant.now()}",
              "stream": "$escapedConnection",
              "server": [
                {
                  "seq": ${frame.sequence},
                  "packetId": ${frame.packetId},
                  "compressed": ${frame.compressed},
                  "payloadSize": ${frame.payloadSize},
                  "totalLength": ${frame.totalLength},
                  "rawFile": "$rawName",
                  "payloadFile": "$payloadName",
                  "sourcePcap": "android-vpn",
                  "stream": "$escapedConnection",
                  "frame": 0,
                  "time": 0,
                  "sha256": "$sha256"
                }
              ]
            }
        """.trimIndent() + "\n"
    }
}
