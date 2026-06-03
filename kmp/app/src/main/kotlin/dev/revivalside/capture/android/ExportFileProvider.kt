package dev.revivalside.capture.android

import android.content.ContentProvider
import android.content.ContentValues
import android.database.Cursor
import android.database.MatrixCursor
import android.net.Uri
import android.os.ParcelFileDescriptor
import android.provider.OpenableColumns
import java.io.File

class ExportFileProvider : ContentProvider() {
    override fun onCreate(): Boolean = true

    override fun getType(uri: Uri): String = "application/zip"

    override fun openFile(uri: Uri, mode: String): ParcelFileDescriptor {
        val file = resolveFile(uri)
        return ParcelFileDescriptor.open(file, ParcelFileDescriptor.MODE_READ_ONLY)
    }

    override fun query(
        uri: Uri,
        projection: Array<out String>?,
        selection: String?,
        selectionArgs: Array<out String>?,
        sortOrder: String?,
    ): Cursor {
        val file = resolveFile(uri)
        val columns = projection ?: arrayOf(OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE)
        val cursor = MatrixCursor(columns)
        val values = columns.map<String, Any?> { column ->
            when (column) {
                OpenableColumns.DISPLAY_NAME -> file.name
                OpenableColumns.SIZE -> file.length()
                else -> null
            }
        }.toTypedArray()
        cursor.addRow(values)
        return cursor
    }

    override fun insert(uri: Uri, values: ContentValues?): Uri? = null

    override fun delete(uri: Uri, selection: String?, selectionArgs: Array<out String>?): Int = 0

    override fun update(uri: Uri, values: ContentValues?, selection: String?, selectionArgs: Array<out String>?): Int = 0

    private fun resolveFile(uri: Uri): File {
        val context = requireNotNull(context)
        val name = requireNotNull(uri.lastPathSegment) { "Missing export name" }
        val file = File(File(context.filesDir, "exports"), name)
        val exportDir = File(context.filesDir, "exports").canonicalFile
        val canonical = file.canonicalFile
        require(canonical.path.startsWith(exportDir.path) && canonical.isFile) { "Export not found" }
        return canonical
    }
}
