package com.weedlaser.bev.data.remote

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.MultipartBody
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.asRequestBody
import okhttp3.RequestBody.Companion.toRequestBody
import java.io.File
import java.io.FileOutputStream
import java.net.DatagramPacket
import java.net.DatagramSocket
import java.net.InetAddress
import java.net.SocketTimeoutException
import java.util.concurrent.TimeUnit

@Serializable
data class NormalizedPoint(
    val nx: Float,
    val ny: Float,
)

@Serializable
data class PiImageUploadResponse(
    val status: String = "ok",
    @SerialName("bev_url") val bevUrl: String = "/bev_image",
    @SerialName("bev_width") val bevWidth: Int = 640,
    @SerialName("bev_height") val bevHeight: Int = 480,
    @SerialName("boundary_corners") val boundaryCorners: List<List<Float>> = emptyList(),
    @SerialName("ridges_nx") val ridgesNx: List<Float> = emptyList(),
    @SerialName("furrows_nx") val furrowsNx: List<Float> = emptyList(),
    val confidence: Float = 0f,
    @SerialName("min_confidence") val minConfidence: Float = 0.45f,
    @SerialName("ready") val ready: Boolean = false,
    @SerialName("bev_warped") val bevWarped: Boolean = false,
    @SerialName("bev_transform_method") val bevTransformMethod: String = "",
    @SerialName("map_feed") val mapFeed: String = "/map_feed",
    @SerialName("video_feed") val videoFeed: String = "/video_feed",
)

@Serializable
data class PiStartMissionRequest(
    val start: NormalizedPoint,
    val end: NormalizedPoint? = null,
    @SerialName("relay_mode") val relayMode: String = "nav_only",
    @SerialName("nav_only") val navOnly: Boolean = true,
    @SerialName("operator_confirmed") val operatorConfirmed: Boolean = false,
    @SerialName("source_type") val sourceType: String = "live_capture",
)

@Serializable
data class CutQueueItem(
    @SerialName("weed_id") val weedId: Int = 0,
    @SerialName("x_ground_mm") val xGroundMm: Float = 0f,
    @SerialName("y_fwd_mm") val yFwdMm: Float = 0f,
    @SerialName("band_mm") val bandMm: Int = 0,
    @SerialName("turret_angle_deg") val turretAngleDeg: Float = 0f,
    val confidence: Float = 0f,
)

@Serializable
data class ChlorosisClipInfo(
    @SerialName("clip_id") val clipId: Int = 0,
    val side: String = "LEFT",
    @SerialName("row_index") val rowIndex: Int = 1,
    val filename: String = "",
    @SerialName("duration_s") val durationS: Float = 3.0f,
)

@Serializable
data class HardwareStatus(
    @SerialName("camera_attached") val cameraAttached: Boolean = false,
    @SerialName("yolo_loaded") val yoloLoaded: Boolean = false,
    @SerialName("esp32_serial") val esp32Serial: Boolean = false,
    @SerialName("simulation_mode") val simulationMode: Boolean = true,
    @SerialName("treatment_actuator_attached") val treatmentActuatorAttached: Boolean = false,
    @SerialName("model_backend") val modelBackend: String = "none",
)

@Serializable
data class CutPlanTelemetry(
    val state: String = "IDLE",
    val running: Boolean = false,
    @SerialName("e_stopped") val eStopped: Boolean = false,
    @SerialName("fault_reason") val faultReason: String? = null,
    val hardware: HardwareStatus = HardwareStatus(),
    @SerialName("rover_pose") val roverPose: NormalizedPoint = NormalizedPoint(0.5f, 0.9f),
    @SerialName("heading_deg") val headingDeg: Float = 0f,
    @SerialName("esp32_drive_deg") val esp32DriveDeg: Int? = null,
    @SerialName("esp32_ack") val esp32Ack: String = "SIM",
    @SerialName("lateral_offset_mm") val lateralOffsetMm: Float = 0f,
    @SerialName("wall_distance_mm") val wallDistanceMm: Float = 1800f,
    @SerialName("turret_angle_deg") val turretAngleDeg: Float = 0f,
    @SerialName("relay1_grinder") val relay1Grinder: Boolean = false,
    @SerialName("relay2_flame") val relay2Flame: Boolean = false,
    @SerialName("relay_mode") val relayMode: String = "nav_only",
    @SerialName("weeds_eliminated") val weedsEliminated: Int = 0,
    @SerialName("cut_queue") val cutQueue: List<CutQueueItem> = emptyList(),
    @SerialName("chlorosis_clips") val chlorosisClips: List<ChlorosisClipInfo> = emptyList(),
)

@Serializable
private data class UdpDiscoveryReply(
    val name: String = "WeedRover-Pi",
    val port: Int = 8000,
    val service: String = "weed-rover-pi5-pipeline",
    @SerialName("auth_required") val authRequired: Boolean = false,
)

data class DiscoveredPiDevice(
    val name: String,
    val ipAddress: String,
    val port: Int,
    val authRequired: Boolean = false,
)

/**
 * Direct HTTP + UDP discovery client for Navigation/src/pi_server.py (port 8000):
 *   - GET  /health         (Readiness & hardware check)
 *   - POST /image          (Upload field photo -> perspective-quad BEV + honest furrow segmentation)
 *   - GET  /bev_image      (Download warped 2D top-down BEV JPEG for exact Start/End tapping)
 *   - POST /start_mission  (Start autonomous mission at tapped BEV Start -> End)
 *   - POST /heartbeat      (Phone keep-alive feeding Pi's 5s link-loss failsafe)
 *   - POST /stop           (Emergency Stop -> motors OFF & Relay 1/2 OFF)
 *   - GET  /cut_plan       (Live JSON telemetry)
 *   - GET  /video_feed     (Live MJPEG camera stream)
 *   - GET  /map_feed       (Live MJPEG BEV field map stream)
 */
class PiLiveClient {

    private val client = OkHttpClient.Builder()
        .connectTimeout(5, TimeUnit.SECONDS)
        .readTimeout(15, TimeUnit.SECONDS)
        .writeTimeout(15, TimeUnit.SECONDS)
        .build()

    private val probeClient = OkHttpClient.Builder()
        .connectTimeout(1200, TimeUnit.MILLISECONDS)
        .readTimeout(1500, TimeUnit.MILLISECONDS)
        .build()

    private val json = Json {
        ignoreUnknownKeys = true
        encodeDefaults = true
    }

    fun videoFeedUrl(ip: String, port: Int, nonce: Int = 0): String =
        "http://$ip:$port/video_feed?r=$nonce"

    fun mapFeedUrl(ip: String, port: Int, nonce: Int = 0): String =
        "http://$ip:$port/map_feed?r=$nonce"

    private fun Request.Builder.withAuth(bearerToken: String?): Request.Builder {
        val clean = bearerToken?.trim().orEmpty()
        if (clean.isNotEmpty()) {
            header("Authorization", "Bearer $clean")
        }
        return this
    }

    suspend fun uploadFieldPhoto(
        ip: String,
        port: Int,
        imageFile: File,
        bearerToken: String? = null,
    ): Result<PiImageUploadResponse> = withContext(Dispatchers.IO) {
        runCatching {
            val body = MultipartBody.Builder()
                .setType(MultipartBody.FORM)
                .addFormDataPart(
                    "file",
                    imageFile.name,
                    imageFile.asRequestBody("image/jpeg".toMediaType()),
                )
                .build()

            val request = Request.Builder()
                .url("http://$ip:$port/image")
                .withAuth(bearerToken)
                .post(body)
                .build()

            client.newCall(request).execute().use { resp ->
                val raw = resp.body?.string().orEmpty()
                if (!resp.isSuccessful) {
                    error("Pi /image rejected (HTTP ${resp.code}): $raw")
                }
                json.decodeFromString<PiImageUploadResponse>(raw)
            }
        }
    }

    /**
     * Download the Pi's exact auto-warped 2D top-down BEV JPEG so Start/End taps and
     * furrow overlays are rendered in BEV coordinates rather than perspective photo space.
     */
    suspend fun downloadBevImage(
        ip: String,
        port: Int,
        bevUrlPath: String,
        destFile: File,
        bearerToken: String? = null,
    ): Result<String> = withContext(Dispatchers.IO) {
        runCatching {
            val normalizedPath = if (bevUrlPath.startsWith("/")) bevUrlPath else "/$bevUrlPath"
            val request = Request.Builder()
                .url("http://$ip:$port$normalizedPath")
                .withAuth(bearerToken)
                .get()
                .build()

            client.newCall(request).execute().use { resp ->
                if (!resp.isSuccessful) {
                    error("Pi /bev_image failed (HTTP ${resp.code})")
                }
                val bytes = resp.body?.bytes() ?: error("Empty BEV image response")
                destFile.parentFile?.mkdirs()
                FileOutputStream(destFile).use { it.write(bytes) }
                destFile.absolutePath
            }
        }
    }

    suspend fun startMission(
        ip: String,
        port: Int,
        start: NormalizedPoint,
        end: NormalizedPoint?,
        relayMode: String = "nav_only",
        navOnly: Boolean = (relayMode == "nav_only"),
        operatorConfirmed: Boolean = false,
        sourceType: String = "live_capture",
        bearerToken: String? = null,
    ): Result<String> = withContext(Dispatchers.IO) {
        runCatching {
            val payload = json.encodeToString(
                PiStartMissionRequest(
                    start = start,
                    end = end,
                    relayMode = relayMode,
                    navOnly = navOnly,
                    operatorConfirmed = operatorConfirmed,
                    sourceType = sourceType,
                )
            )
            val request = Request.Builder()
                .url("http://$ip:$port/start_mission")
                .withAuth(bearerToken)
                .post(payload.toRequestBody("application/json".toMediaType()))
                .build()

            client.newCall(request).execute().use { resp ->
                val raw = resp.body?.string().orEmpty()
                if (!resp.isSuccessful) {
                    error("Pi /start_mission rejected (HTTP ${resp.code}): $raw")
                }
                raw
            }
        }
    }

    suspend fun sendHeartbeat(
        ip: String,
        port: Int,
        bearerToken: String? = null,
    ): Result<Unit> = withContext(Dispatchers.IO) {
        runCatching {
            val request = Request.Builder()
                .url("http://$ip:$port/heartbeat")
                .withAuth(bearerToken)
                .post("{}".toRequestBody("application/json".toMediaType()))
                .build()
            probeClient.newCall(request).execute().use { resp ->
                if (!resp.isSuccessful) error("Heartbeat rejected (HTTP ${resp.code})")
            }
        }
    }

    suspend fun emergencyStop(
        ip: String,
        port: Int,
        bearerToken: String? = null,
    ): Result<Unit> = withContext(Dispatchers.IO) {
        runCatching {
            val request = Request.Builder()
                .url("http://$ip:$port/stop")
                .withAuth(bearerToken)
                .post("{}".toRequestBody("application/json".toMediaType()))
                .build()
            client.newCall(request).execute().use { resp ->
                val raw = resp.body?.string().orEmpty()
                if (!resp.isSuccessful) error("E-STOP rejected (HTTP ${resp.code}): $raw")
            }
        }
    }

    suspend fun fetchCutPlan(
        ip: String,
        port: Int,
        bearerToken: String? = null,
    ): Result<CutPlanTelemetry> = withContext(Dispatchers.IO) {
        runCatching {
            val request = Request.Builder()
                .url("http://$ip:$port/cut_plan")
                .withAuth(bearerToken)
                .get()
                .build()
            probeClient.newCall(request).execute().use { resp ->
                val raw = resp.body?.string().orEmpty()
                if (!resp.isSuccessful) error("Pi /cut_plan failed (HTTP ${resp.code})")
                json.decodeFromString<CutPlanTelemetry>(raw)
            }
        }
    }

    /**
     * Broadcast UDP discovery packet on port 8081 matching pi_server.py's responder,
     * and also directly probe the default Pi hotspot (192.168.4.1:8000/health).
     */
    suspend fun discoverPiServers(timeoutMs: Int = 1800): Result<List<DiscoveredPiDevice>> =
        withContext(Dispatchers.IO) {
            runCatching {
                val found = linkedMapOf<String, DiscoveredPiDevice>()

                // 1. UDP broadcast discovery on port 8081
                runCatching {
                    DatagramSocket().use { sock ->
                        sock.broadcast = true
                        sock.soTimeout = 500
                        val msg = "DISCOVER_WEED_ROVER".toByteArray(Charsets.UTF_8)
                        val packet = DatagramPacket(
                            msg,
                            msg.size,
                            InetAddress.getByName("255.255.255.255"),
                            8081,
                        )
                        sock.send(packet)

                        val deadline = System.currentTimeMillis() + timeoutMs
                        val buf = ByteArray(1024)
                        while (System.currentTimeMillis() < deadline) {
                            try {
                                val resp = DatagramPacket(buf, buf.size)
                                sock.receive(resp)
                                val text = String(resp.data, 0, resp.length, Charsets.UTF_8)
                                val parsed = json.decodeFromString<UdpDiscoveryReply>(text)
                                val host = resp.address.hostAddress ?: continue
                                found["$host:${parsed.port}"] = DiscoveredPiDevice(
                                    name = parsed.name,
                                    ipAddress = host,
                                    port = parsed.port,
                                    authRequired = parsed.authRequired,
                                )
                            } catch (_: SocketTimeoutException) {
                                // keep listening until deadline
                            }
                        }
                    }
                }

                // 2. Direct Pi hotspot health probe fallback (192.168.4.1:8000)
                if (found.isEmpty()) {
                    val hotspotIp = "192.168.4.1"
                    val hotspotPort = 8000
                    runCatching {
                        val req = Request.Builder()
                            .url("http://$hotspotIp:$hotspotPort/health")
                            .get()
                            .build()
                        probeClient.newCall(req).execute().use { resp ->
                            if (resp.isSuccessful) {
                                found["$hotspotIp:$hotspotPort"] = DiscoveredPiDevice(
                                    name = "WeedRover-Pi Hotspot",
                                    ipAddress = hotspotIp,
                                    port = hotspotPort,
                                )
                            }
                        }
                    }
                }

                found.values.toList()
            }
        }
}
