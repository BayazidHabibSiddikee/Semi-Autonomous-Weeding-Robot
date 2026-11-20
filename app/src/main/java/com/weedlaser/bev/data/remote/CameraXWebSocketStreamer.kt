package com.weedlaser.bev.data.remote

import android.graphics.ImageFormat
import android.graphics.Rect
import android.graphics.YuvImage
import androidx.camera.core.ImageAnalysis
import androidx.camera.core.ImageProxy
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import okio.ByteString.Companion.toByteString
import java.io.ByteArrayOutputStream
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicLong

/**
 * Real-time Android CameraX -> WebSocket JPEG Streamer.
 *
 * Streams live forward crop-row camera frames from CameraX [ImageAnalysis] directly to the
 * web Navigation Console's `/ws/camera?room=<room>&role=publisher&transport=camerax` endpoint.
 *
 * Uses only dependencies already bundled in `app/build.gradle.kts` (CameraX 1.3.3 + OkHttp 4.12).
 */
class CameraXWebSocketStreamer(
    private val serverWsUrl: String,
    private val roomId: String = "rover-01",
    private val deviceLabel: String = "Android CameraX",
    private val targetFps: Int = 15,
    private val jpegQuality: Int = 65,
    private val scope: CoroutineScope = CoroutineScope(Dispatchers.IO)
) : ImageAnalysis.Analyzer {

    enum class StreamState {
        DISCONNECTED,
        CONNECTING,
        STREAMING,
        RECONNECTING
    }

    private val _state = MutableStateFlow(StreamState.DISCONNECTED)
    val state: StateFlow<StreamState> = _state.asStateFlow()

    private val client = OkHttpClient.Builder()
        .pingInterval(15, TimeUnit.SECONDS)
        .connectTimeout(8, TimeUnit.SECONDS)
        .readTimeout(0, TimeUnit.MILLISECONDS)
        .build()

    @Volatile
    private var webSocket: WebSocket? = null
    private val isActive = AtomicBoolean(false)
    private val lastFrameSentMs = AtomicLong(0L)
    private val minFrameIntervalMs = (1000L / targetFps.coerceIn(1, 30))
    private var reconnectJob: Job? = null

    fun start() {
        if (!isActive.compareAndSet(false, true)) return
        connectInternal()
    }

    fun stop() {
        isActive.set(false)
        reconnectJob?.cancel()
        reconnectJob = null
        webSocket?.close(1000, "Operator stopped stream")
        webSocket = null
        _state.value = StreamState.DISCONNECTED
    }

    private fun buildEndpointUrl(): String {
        val base = serverWsUrl.trimEnd('/')
        val sep = if (base.contains("?")) "&" else "?"
        val encodedLabel = java.net.URLEncoder.encode(deviceLabel, "UTF-8")
        return "$base${sep}room=$roomId&role=publisher&transport=camerax&label=$encodedLabel"
    }

    private fun connectInternal() {
        if (!isActive.get()) return
        _state.value = StreamState.CONNECTING

        val request = Request.Builder()
            .url(buildEndpointUrl())
            .build()

        webSocket = client.newWebSocket(request, object : WebSocketListener() {
            override fun onOpen(ws: WebSocket, response: Response) {
                _state.value = StreamState.STREAMING
            }

            override fun onClosed(ws: WebSocket, code: Int, reason: String) {
                if (isActive.get()) scheduleReconnect() else _state.value = StreamState.DISCONNECTED
            }

            override fun onFailure(ws: WebSocket, t: Throwable, response: Response?) {
                if (isActive.get()) scheduleReconnect() else _state.value = StreamState.DISCONNECTED
            }
        })
    }

    private fun scheduleReconnect() {
        _state.value = StreamState.RECONNECTING
        reconnectJob?.cancel()
        reconnectJob = scope.launch {
            delay(2000L)
            if (isActive.get()) {
                connectInternal()
            }
        }
    }

    /**
     * Invoked by CameraX ImageAnalysis on every camera frame.
     * Drops frames cleanly when pacing exceeds [targetFps] or WebSocket send queue backs up.
     */
    override fun analyze(image: ImageProxy) {
        try {
            val ws = webSocket
            if (!isActive.get() || ws == null || _state.value != StreamState.STREAMING) {
                return
            }

            val now = System.currentTimeMillis()
            if (now - lastFrameSentMs.get() < minFrameIntervalMs) {
                return
            }

            // Backpressure guard: drop frame if outbound buffer exceeds 256 KB
            if (ws.queueSize() > 256 * 1024) {
                return
            }

            val jpegBytes = yuv420888ToJpeg(image, jpegQuality) ?: return
            if (ws.send(jpegBytes.toByteString(0, jpegBytes.size))) {
                lastFrameSentMs.set(now)
            }
        } finally {
            image.close()
        }
    }

    private fun yuv420888ToJpeg(image: ImageProxy, quality: Int): ByteArray? {
        if (image.format != ImageFormat.YUV_420_888) return null
        val yBuffer = image.planes[0].buffer
        val uBuffer = image.planes[1].buffer
        val vBuffer = image.planes[2].buffer

        val ySize = yBuffer.remaining()
        val uSize = uBuffer.remaining()
        val vSize = vBuffer.remaining()

        val nv21 = ByteArray(ySize + uSize + vSize)
        yBuffer.get(nv21, 0, ySize)
        vBuffer.get(nv21, ySize, vSize)
        uBuffer.get(nv21, ySize + vSize, uSize)

        val yuvImage = YuvImage(nv21, ImageFormat.NV21, image.width, image.height, null)
        val out = ByteArrayOutputStream()
        yuvImage.compressToJpeg(Rect(0, 0, image.width, image.height), quality, out)
        return out.toByteArray()
    }
}
