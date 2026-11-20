package com.weedlaser.bev.presentation

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.weedlaser.bev.core.opencv.AutoFieldBoundaryDetector
import com.weedlaser.bev.core.opencv.OpenCVProcessor
import com.weedlaser.bev.core.opencv.RowDetector
import com.weedlaser.bev.data.remote.CutPlanTelemetry
import com.weedlaser.bev.data.remote.DiscoveredPiDevice
import com.weedlaser.bev.data.remote.NormalizedPoint
import com.weedlaser.bev.data.remote.PiLiveClient
import com.weedlaser.bev.data.remote.WifiNetworkBinder
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import org.opencv.core.Point
import java.io.File

/**
 * Single source of truth for the Zero-Corner Launch & Live Rover Monitor flows.
 * State survives tab switches (Launch <-> Live <-> Project <-> About) and screen rotations.
 */
class BeViewModel(
    val piClient: PiLiveClient,
    private val wifiBinder: WifiNetworkBinder,
    private val openCVProcessor: OpenCVProcessor,
    private val rowDetector: RowDetector,
    private val bevOutputDir: File,
) : ViewModel() {

    // Pi hotspot endpoint & optional Bearer security token (held in memory only)
    var piIp by mutableStateOf("192.168.4.1")
        private set
    var piPortText by mutableStateOf("8000")
        private set
    var apiToken by mutableStateOf("")
        private set
    var wifiBound by mutableStateOf(false)
        private set
    var discoveredDevices by mutableStateOf<List<DiscoveredPiDevice>>(emptyList())
        private set
    var isDiscovering by mutableStateOf(false)
        private set

    // Captured photo & warped 2D top-down BEV state
    var sourcePhotoPath by mutableStateOf<String?>(null)
        private set
    var bevImagePath by mutableStateOf<String?>(null)
        private set
    var isPiBevReady by mutableStateOf(false)
        private set
    var furrowsNx by mutableStateOf<List<Float>>(emptyList())
        private set
    var detectionConfidence by mutableStateOf(0f)
        private set

    // User-tapped BEV coordinates (start null — never silently pre-filled!)
    var startPoint by mutableStateOf<NormalizedPoint?>(null)
        private set
    var endPoint by mutableStateOf<NormalizedPoint?>(null)
        private set
    var relayMode by mutableStateOf("grinder")
        private set

    // Status & error banners
    var isUploading by mutableStateOf(false)
        private set
    var isStartingMission by mutableStateOf(false)
        private set
    var statusMessage by mutableStateOf<String?>(null)
        private set
    var errorMessage by mutableStateOf<String?>(null)
        private set

    // Live Rover Monitor state
    var telemetry by mutableStateOf(CutPlanTelemetry())
        private set
    var streamConnected by mutableStateOf(false)
        private set
    var liveError by mutableStateOf<String?>(null)
        private set
    var eStopBusy by mutableStateOf(false)
        private set
    var eStopError by mutableStateOf<String?>(null)
        private set
    var streamReconnectNonce by mutableIntStateOf(0)
        private set

    private var livePollJob: Job? = null
    private var heartbeatJob: Job? = null

    val effectivePort: Int
        get() = piPortText.toIntOrNull()?.takeIf { it in 1..65535 } ?: 8000

    /**
     * Launch is strictly gated:
     *   - Photo uploaded to Pi AND Pi returned warped BEV image
     *   - Pi segmentation confidence >= MIN_CONFIDENCE (0.45) AND at least 1 real furrow detected
     *   - Operator explicitly tapped a Start point on the warped BEV map
     */
    val canStartMission: Boolean
        get() = isPiBevReady &&
            bevImagePath != null &&
            detectionConfidence >= MIN_CONFIDENCE &&
            furrowsNx.isNotEmpty() &&
            startPoint != null &&
            !isUploading &&
            !isStartingMission

    fun updatePiIp(ip: String) {
        val trimmed = ip.trim()
        if (trimmed != piIp) {
            piIp = trimmed
            // Endpoint changed: require fresh upload to new Pi host
            isPiBevReady = false
        }
    }

    fun updatePiPortText(raw: String) {
        // Allow user to clear or type digits freely without snapping back to 8000
        val digitsOnly = raw.filter { it.isDigit() }.take(5)
        if (digitsOnly != piPortText) {
            piPortText = digitsOnly
            isPiBevReady = false
        }
    }

    fun updateApiToken(token: String) {
        apiToken = token
    }

    fun updateRelayMode(mode: String) {
        if (mode in listOf("grinder", "flame", "both")) {
            relayMode = mode
        }
    }

    fun updateStartPoint(pt: NormalizedPoint) {
        startPoint = pt
        errorMessage = null
    }

    fun updateEndPoint(pt: NormalizedPoint?) {
        endPoint = pt
    }

    fun selectDiscoveredDevice(dev: DiscoveredPiDevice) {
        piIp = dev.ipAddress
        piPortText = dev.port.toString()
        isPiBevReady = false
        statusMessage = "Selected ${dev.name} (${dev.ipAddress}:${dev.port})"
        errorMessage = null
    }

    fun bindPiWifiHotspot() {
        viewModelScope.launch {
            errorMessage = null
            statusMessage = "Binding process to Pi Wi-Fi hotspot..."
            wifiBinder.bindToWifiHotspot()
                .onSuccess { ok ->
                    wifiBound = ok
                    statusMessage = if (ok) {
                        "Bound to Wi-Fi hotspot — HTTP traffic routes directly to Pi."
                    } else {
                        "Wi-Fi binding returned false. Verify phone is connected to Pi Wi-Fi."
                    }
                }
                .onFailure { err ->
                    wifiBound = false
                    errorMessage = err.message ?: "Failed to bind Wi-Fi hotspot"
                }
        }
    }

    fun discoverPiOnLan() {
        if (isDiscovering) return
        viewModelScope.launch {
            isDiscovering = true
            errorMessage = null
            statusMessage = "Scanning UDP :8081 & Pi hotspot for Weed Rover..."
            piClient.discoverPiServers()
                .onSuccess { list ->
                    discoveredDevices = list
                    if (list.isNotEmpty()) {
                        val first = list.first()
                        piIp = first.ipAddress
                        piPortText = first.port.toString()
                        statusMessage = "Found ${list.size} Pi server(s): ${first.name} (${first.ipAddress}:${first.port})"
                    } else {
                        errorMessage = "No Pi server found. Connect to Pi Wi-Fi hotspot or enter IP manually."
                    }
                }
                .onFailure { err ->
                    errorMessage = "Discovery failed: ${err.message}"
                }
            isDiscovering = false
        }
    }

    /**
     * Ingest a newly captured/picked field photo:
     *   1. Upload to Pi POST /image.
     *   2. Download Pi's exact warped 2D Top-Down BEV JPEG via GET /bev_image so the user
     *      taps Start/End in true BEV coordinates (never perspective photo coordinates).
     *   3. If Pi is unreachable, run local ExG boundary + OpenCVProcessor BEV warp as an
     *      honest offline preview (NEVER fabricates fake furrows and keeps isPiBevReady = false).
     */
    fun onNewFieldPhoto(path: String) {
        sourcePhotoPath = path
        bevImagePath = null
        isPiBevReady = false
        furrowsNx = emptyList()
        detectionConfidence = 0f
        startPoint = null
        endPoint = null
        errorMessage = null
        uploadCurrentPhotoToPi()
    }

    fun uploadCurrentPhotoToPi() {
        val path = sourcePhotoPath ?: return
        if (isUploading) return
        viewModelScope.launch {
            isUploading = true
            isPiBevReady = false
            errorMessage = null
            statusMessage = "Uploading photo to Pi ($piIp:$effectivePort/image)..."

            val uploadResult = piClient.uploadFieldPhoto(
                ip = piIp,
                port = effectivePort,
                imageFile = File(path),
                bearerToken = apiToken.ifBlank { null },
            )

            uploadResult.onSuccess { resp ->
                furrowsNx = resp.furrowsNx
                detectionConfidence = resp.confidence
                startPoint = null
                endPoint = null

                // Download the Pi's exact warped BEV JPEG so taps match Pi's BEV coordinate space
                val localBevFile = File(bevOutputDir, "pi_bev_${System.currentTimeMillis()}.jpg")
                val bevDownload = piClient.downloadBevImage(
                    ip = piIp,
                    port = effectivePort,
                    bevUrlPath = resp.bevUrl,
                    destFile = localBevFile,
                )

                bevDownload.onSuccess { savedBev ->
                    bevImagePath = savedBev
                    val pct = (resp.confidence * 100).toInt()
                    if (resp.ready && resp.confidence >= MIN_CONFIDENCE && resp.furrowsNx.isNotEmpty()) {
                        isPiBevReady = true
                        statusMessage = "Pi BEV ready: ${resp.furrowsNx.size} furrows ($pct% confidence). Tap Start & End on the top-down map."
                    } else {
                        isPiBevReady = false
                        errorMessage = "Low row-detection confidence ($pct%, ${resp.furrowsNx.size} furrows). Recapture a clearer photo of crop rows before launching."
                    }
                }.onFailure { err ->
                    isPiBevReady = false
                    errorMessage = "Photo uploaded, but failed to fetch Pi BEV map (/bev_image): ${err.message}"
                }
            }.onFailure { err ->
                // Pi is offline or rejected auth/upload -> produce an honest local BEV preview using
                // AutoFieldBoundaryDetector + OpenCVProcessor + RowDetector, but NEVER fake furrows or allow launch.
                isPiBevReady = false
                errorMessage = "Pi upload failed (${err.message}). Showing local offline BEV preview — connect Pi & upload before launching."
                buildOfflineLocalBevPreview(path)
            }

            isUploading = false
        }
    }

    private suspend fun buildOfflineLocalBevPreview(sourcePath: String) = withContext(Dispatchers.Default) {
        val boundary = AutoFieldBoundaryDetector.detectFromImageFile(sourcePath).getOrNull() ?: return@withContext
        val corners = boundary.corners
        val srcPts = listOf(
            Point(corners.topLeft.x.toDouble(), corners.topLeft.y.toDouble()),
            Point(corners.topRight.x.toDouble(), corners.topRight.y.toDouble()),
            Point(corners.bottomRight.x.toDouble(), corners.bottomRight.y.toDouble()),
            Point(corners.bottomLeft.x.toDouble(), corners.bottomLeft.y.toDouble()),
        )
        val previewOut = File(bevOutputDir, "local_preview_bev_${System.currentTimeMillis()}.jpg")
        val warpRes = openCVProcessor.warpToBEV(
            inputPath = sourcePath,
            outputPath = previewOut.absolutePath,
            srcCorners = srcPts,
            outputW = 640,
            outputH = 480,
        )
        if (warpRes.isSuccess) {
            val rowRes = rowDetector.detect(
                bevPath = previewOut.absolutePath,
                expectedCount = null,
                useNativeOpenCV = openCVProcessor.isNativeAvailable(),
            ).getOrNull()

            val localFurrows = if (rowRes != null && rowRes.rowCentersX.size >= 2 && rowRes.bevWidth > 0) {
                val ridgesNx = rowRes.rowCentersX.map { (it / rowRes.bevWidth.toFloat()).coerceIn(0.05f, 0.95f) }.sorted()
                (0 until ridgesNx.size - 1).map { i -> (ridgesNx[i] + ridgesNx[i + 1]) / 2f }
            } else {
                emptyList()
            }

            withContext(Dispatchers.Main) {
                bevImagePath = previewOut.absolutePath
                furrowsNx = localFurrows
                detectionConfidence = rowRes?.confidence ?: 0f
            }
        }
    }

    /**
     * Strictly gated mission launch:
     *   - Never silently re-uploads and ignores errors.
     *   - Never navigates to Live tab when /start_mission fails.
     */
    fun launchMission(onSuccessNavigateToLive: () -> Unit) {
        val sp = startPoint
        if (!canStartMission || sp == null) {
            errorMessage = "Upload field photo to Pi (>=45% confidence) and tap a Start point first."
            return
        }
        viewModelScope.launch {
            isStartingMission = true
            errorMessage = null
            statusMessage = "Sending Start/End BEV coordinates to Pi ($piIp:$effectivePort)..."

            piClient.startMission(
                ip = piIp,
                port = effectivePort,
                start = sp,
                end = endPoint,
                relayMode = relayMode,
                bearerToken = apiToken.ifBlank { null },
            ).onSuccess {
                statusMessage = "Mission running on Pi — switching to Live Monitor."
                eStopError = null
                startHeartbeatLoop()
                onSuccessNavigateToLive()
            }.onFailure { err ->
                // Stay on Launch tab so operator sees the real error!
                errorMessage = "Failed to start mission on Pi: ${err.message}"
                statusMessage = null
            }

            isStartingMission = false
        }
    }

    fun startLiveMonitoring() {
        if (livePollJob?.isActive == true) return
        livePollJob = viewModelScope.launch {
            var wasConnected = false
            while (isActive) {
                piClient.fetchCutPlan(piIp, effectivePort)
                    .onSuccess { data ->
                        telemetry = data
                        if (!wasConnected) {
                            // Auto-reconnect MJPEG streams when Pi comes online
                            streamReconnectNonce++
                        }
                        wasConnected = true
                        streamConnected = true
                        liveError = null
                        if (data.running && heartbeatJob?.isActive != true) {
                            startHeartbeatLoop()
                        }
                    }
                    .onFailure { err ->
                        wasConnected = false
                        streamConnected = false
                        liveError = err.message ?: "offline"
                    }
                delay(400L)
            }
        }
    }

    fun stopLiveMonitoring() {
        livePollJob?.cancel()
        livePollJob = null
    }

    private fun startHeartbeatLoop() {
        heartbeatJob?.cancel()
        heartbeatJob = viewModelScope.launch {
            while (isActive) {
                if (telemetry.running || isStartingMission) {
                    piClient.sendHeartbeat(piIp, effectivePort, apiToken.ifBlank { null })
                }
                delay(1500L)
            }
        }
    }

    fun triggerStreamReconnect() {
        streamReconnectNonce++
    }

    fun triggerEmergencyStop() {
        if (eStopBusy) return
        viewModelScope.launch {
            eStopBusy = true
            eStopError = null
            piClient.emergencyStop(piIp, effectivePort, apiToken.ifBlank { null })
                .onSuccess {
                    eStopError = null
                    heartbeatJob?.cancel()
                    telemetry = telemetry.copy(
                        running = false,
                        eStopped = true,
                        state = "E_STOP",
                        relay1Grinder = false,
                        relay2Flame = false,
                    )
                }
                .onFailure { err ->
                    // Surface E-STOP failure loudly so operator knows to retry or pull hardware switch
                    eStopError = "E-STOP NOT CONFIRMED: ${err.message ?: "Pi unreachable"}. Retry or press rover hardware E-STOP!"
                }
            eStopBusy = false
        }
    }

    override fun onCleared() {
        livePollJob?.cancel()
        heartbeatJob?.cancel()
        wifiBinder.releaseBinding()
        super.onCleared()
    }

    companion object {
        const val MIN_CONFIDENCE = 0.45f
    }
}
