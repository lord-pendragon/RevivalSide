package dev.revivalside.capture.protocol

fun ByteArray.toLowerHex(): String {
    val chars = CharArray(size * 2)
    var output = 0
    for (byte in this) {
        val value = byte.toInt() and 0xff
        chars[output++] = HEX[value ushr 4]
        chars[output++] = HEX[value and 0x0f]
    }
    return chars.concatToString()
}

private val HEX = "0123456789abcdef".toCharArray()
