package dev.revivalside.capture.protocol

data class CapturedCounterSideFrame(
    val raw: ByteArray,
    val payload: ByteArray,
    val sequence: Long,
    val packetId: Int,
    val compressed: Boolean,
    val payloadSize: Int,
    val totalLength: Int,
)

class CounterSideFrameScanner(
    private val maxFrameBytes: Int = 8 * 1024 * 1024,
) {
    private var buffer = ByteArray(0)

    fun push(bytes: ByteArray, length: Int = bytes.size): List<CapturedCounterSideFrame> {
        if (length <= 0) return emptyList()
        buffer += bytes.copyOfRange(0, length)
        val frames = mutableListOf<CapturedCounterSideFrame>()

        while (buffer.size >= MIN_FRAME_BYTES) {
            val head = buffer.indexOfHead()
            if (head < 0) {
                buffer = buffer.takeLastBytes(HEAD_BYTES.size - 1)
                break
            }
            if (head > 0) {
                buffer = buffer.copyOfRange(head, buffer.size)
            }
            if (buffer.size < MIN_FRAME_BYTES) break

            val totalLength = buffer.readIntLe(4)
            if (totalLength <= MIN_FRAME_BYTES || totalLength > maxFrameBytes) {
                buffer = buffer.copyOfRange(1, buffer.size)
                continue
            }
            if (buffer.size < totalLength) break

            val raw = buffer.copyOfRange(0, totalLength)
            if (raw.readUIntLe(totalLength - 4) != TAIL_FENCE) {
                buffer = buffer.copyOfRange(1, buffer.size)
                continue
            }

            val parsed = raw.parseFrameOrNull(totalLength)
            if (parsed != null) frames += parsed
            buffer = buffer.copyOfRange(totalLength, buffer.size)
        }

        return frames
    }

    private fun ByteArray.parseFrameOrNull(totalLength: Int): CapturedCounterSideFrame? {
        var offset = 8
        val sequenceRaw = readVarLong(offset) ?: return null
        offset = sequenceRaw.nextOffset
        val packetIdRaw = readVarInt(offset) ?: return null
        offset = packetIdRaw.nextOffset
        if (offset >= size) return null
        val compressed = this[offset].toInt() != 0
        offset += 1
        val payloadSizeRaw = readVarInt(offset) ?: return null
        offset = payloadSizeRaw.nextOffset
        val payloadSize = zigZagDecode32(payloadSizeRaw.value)
        if (payloadSize < 0) return null
        val payloadStart = offset
        val payloadEnd = payloadStart + payloadSize
        if (payloadEnd > totalLength - 4) return null
        return CapturedCounterSideFrame(
            raw = copyOfRange(0, totalLength),
            payload = copyOfRange(payloadStart, payloadEnd),
            sequence = zigZagDecode64(sequenceRaw.value),
            packetId = packetIdRaw.value,
            compressed = compressed,
            payloadSize = payloadSize,
            totalLength = totalLength,
        )
    }

    private fun ByteArray.indexOfHead(): Int {
        for (index in 0..size - HEAD_BYTES.size) {
            if (
                this[index] == HEAD_BYTES[0] &&
                this[index + 1] == HEAD_BYTES[1] &&
                this[index + 2] == HEAD_BYTES[2] &&
                this[index + 3] == HEAD_BYTES[3]
            ) {
                return index
            }
        }
        return -1
    }

    private fun ByteArray.takeLastBytes(count: Int): ByteArray {
        if (count <= 0 || isEmpty()) return ByteArray(0)
        return copyOfRange(kotlin.math.max(0, size - count), size)
    }

    private data class VarIntResult(val value: Int, val nextOffset: Int)
    private data class VarLongResult(val value: Long, val nextOffset: Int)

    private fun ByteArray.readVarInt(startOffset: Int): VarIntResult? {
        var result = 0
        var shift = 0
        var offset = startOffset
        while (offset < size && shift < 35) {
            val byte = this[offset++].toInt() and 0xff
            result = result or ((byte and 0x7f) shl shift)
            if ((byte and 0x80) == 0) return VarIntResult(result, offset)
            shift += 7
        }
        return null
    }

    private fun ByteArray.readVarLong(startOffset: Int): VarLongResult? {
        var result = 0L
        var shift = 0
        var offset = startOffset
        while (offset < size && shift < 70) {
            val byte = this[offset++].toLong() and 0xffL
            result = result or ((byte and 0x7fL) shl shift)
            if ((byte and 0x80L) == 0L) return VarLongResult(result, offset)
            shift += 7
        }
        return null
    }

    private fun ByteArray.readIntLe(offset: Int): Int {
        return (this[offset].toInt() and 0xff) or
            ((this[offset + 1].toInt() and 0xff) shl 8) or
            ((this[offset + 2].toInt() and 0xff) shl 16) or
            ((this[offset + 3].toInt() and 0xff) shl 24)
    }

    private fun ByteArray.readUIntLe(offset: Int): Long {
        return readIntLe(offset).toLong() and 0xffffffffL
    }

    private fun zigZagDecode32(value: Int): Int = (value ushr 1) xor -(value and 1)

    private fun zigZagDecode64(value: Long): Long = (value ushr 1) xor -(value and 1L)

    private companion object {
        const val MIN_FRAME_BYTES = 12
        const val TAIL_FENCE = 0x11223344L
        val HEAD_BYTES = byteArrayOf(0xdd.toByte(), 0xcc.toByte(), 0xbb.toByte(), 0xaa.toByte())
    }
}
