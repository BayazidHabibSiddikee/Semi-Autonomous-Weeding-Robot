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
import java.util.concurrent.TimeUnit

@Serializable
data class NormalizedPoint(
    val nx: Float,
    val ny: Float,
)

@Serializable
data class PiImageUploadResponse(
    val status: String = "ok",
    @SerialName("bev_width") val bevWidth: Int = 640,
    @SerialName("bev_height") val bevHeight: Int = 480,
    @SerialName("ridges_nx") val ridgesNx: List<Float> = emptyList(),
    @SerialName("furrows_nx") val furrowsNx: List<Float> = emptyList(),
    val confidence: Float = 0f,
    @SerialName("map_feed") val mapFeed: String = "/map_feed",
    @SerialName("video_feed") val videoFeed: String = "/video_feed",
)

@Serializable
data class PiStartMissionRequest(
    val start: NormalizedPoint,
    val end: NormalizedPoint? = null,
    @SerialName("relay_mode") val relayMode: String = "grinder",
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
data class CutPlanTelemetry(
    val state: String = "IDLE",
    val running: Boolean = false,
    @SerialName("e_stopped") val eStopped: Boolean = false,
    @SerialName("rover_pose") val roverPose: NormalizedPoint = NormalizedPoint(0.25f, 0.9f),
    @SerialName("heading_deg") val headingDeg: Float = 0f,
    @SerialName("esp32_drive_deg") val esp32DriveDeg: Int? = null,
    @SerialName("lateral_offset_mm") val lateralOffsetMm: Float = 0f,
    @SerialName("wall_distance_mm") val wallDistanceMm: Float = 1800f,
    @SerialName("turret_angle_deg") val turretAngleDeg: Float = 0f,
    @SerialName("relay1_grinder") val relay1Grinder: Boolean = false,
    @SerialName("relay2_flame") val relay2Flame: Boolean = false,
    @SerialName("relay_mode") val relayMode: String = "grinder",
    @SerialName("weeds_eliminated") val weedsEliminated: Int = 0,
    @SerialName("cut_queue") val cutQueue: List<CutQueueItem> = emptyList(),
    @SerialName("chlorosis_clips") val chlorosisClips: List<ChlorosisClipInfo> = emptyList(),
)

/**
 * Direct HTTP client for the Raspberry Pi 4/5 FastAPI Onboard Pipeline:
 *   - POST /image          (Upload 1 field photo -> auto boundary + BEV + furrow segmentation)
 *   - POST /start_mission  (Send Start & End points -> Pi starts autonomous weeding)
 *   - POST /stop           (Emergency Stop)
 *   - GET  /cut_plan       (Live telemetry: heading, turret angle, 30mm cut queue, relays)
 *   - GET  /video_feed     (Live MJPEG camera stream)
 *   - GET  /map_feed       (Live MJPEG BEV field map stream)
 */
class PiLiveClient {

    private val client = OkHttpClient.Builder()
        .connectTimeout(5, TimeUnit.SECONDS)
        .readTimeout(15, TimeUnit.SECONDS)
        .writeTimeout(15, TimeUnit.SECONDS)
        .build()

    private val json = Json {
        ignoreUnknownKeys = true
        encodeDefaults = true
    }

    fun videoFeedUrl(ip: String, port: Int): String = "http://$ip:$port/video_feed"
    fun mapFeedUrl(ip: String, port: Int): String = "http://$ip:$port/map_feed"

    suspend fun uploadFieldPhoto(
        ip: String,
        port: Int,
        imageFile: File,
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
                .post(body)
                .build()

            client.newCall(request).execute().use { resp ->
                val raw = resp.body?.string().orEmpty()
                if (!resp.isSuccessful) {
                    error("Pi /image rejected (${resp.code}): $raw")
                }
                json.decodeFromString<PiImageUploadResponse>(raw)
            }
        }
    }

    suspend fun startMission(
        ip: String,
        port: Int,
        start: NormalizedPoint,
        end: NormalizedPoint?,
        relayMode: String = "grinder",
    ): Result<String> = withContext(Dispatchers.IO) {
        runCatching {
            val payload = json.encodeToString(PiStartMissionRequest(start, end, relayMode))
            val request = Request.Builder()
                .url("http://$ip:$port/start_mission")
                .post(payload.toRequestBody("application/json".toMediaType()))
                .build()

            client.newCall(request).execute().use { resp ->
                val raw = resp.body?.string().orEmpty()
                if (!resp.isSuccessful) {
                    error("Pi /start_mission failed (${resp.code}): $raw")
                }
                raw
            }
        }
    }

    suspend fun emergencyStop(ip: String, port: Int): Result<Unit> = withContext(Dispatchers.IO) {
        runCatching {
            val request = Request.Builder()
                .url("http://$ip:$port/stop")
                .post("{}".toRequestBody("application/json".toMediaType()))
                .build()
            client.newCall(request).execute().use { resp ->
                if (!resp.isSuccessful) error("Pi /stop failed (${resp.code})")
            }
        }
    }

    suspend fun fetchCutPlan(ip: String, port: Int): Result<CutPlanTelemetry> = withContext(Dispatchers.IO) {
        runCatching {
            val request = Request.Builder()
                .url("http://$ip:$port/cut_plan")
                .get()
                .build()
            client.newCall(request).execute().use { resp ->
                val raw = resp.body?.string().orEmpty()
                if (!resp.isSuccessful) error("Pi /cut_plan failed (${resp.code})")
                json.decodeFromString<CutPlanTelemetry>(raw)
            }
        }
    }
}
