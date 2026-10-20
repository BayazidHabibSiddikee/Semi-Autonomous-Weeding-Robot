package com.weedlaser.bev.presentation

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.weedlaser.bev.domain.model.Field
import com.weedlaser.bev.domain.model.FieldCorners
import com.weedlaser.bev.domain.model.HomographyCalibration
import com.weedlaser.bev.domain.model.Mission
import com.weedlaser.bev.domain.model.MissionStatus
import com.weedlaser.bev.domain.model.PiImageResponse
import com.weedlaser.bev.domain.model.RowDetectionResult
import com.weedlaser.bev.data.remote.PiNetworkClient
import com.weedlaser.bev.domain.usecase.DetectRowsUseCase
import com.weedlaser.bev.domain.usecase.GenerateBEVUseCase
import com.weedlaser.bev.domain.usecase.GenerateMissionUseCase
import com.weedlaser.bev.domain.usecase.SaveFieldUseCase
import com.weedlaser.bev.domain.usecase.SendMissionUseCase
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.serialization.json.Json

/**
 * Result of the full BEV → Mission pipeline.
 */
sealed interface BevOutcome {
    data class Success(
        val bevPath: String,
        val calibration: HomographyCalibration,
        val rows: RowDetectionResult,
        val mission: Mission,
    ) : BevOutcome

    data class Error(val message: String) : BevOutcome
    object Idle : BevOutcome
}

/**
 * ViewModel driving the full pipeline:
 * capture → corner selection → BEV → row detection → mission → send.
 */
class BeViewModel(
    private val generateBEV: GenerateBEVUseCase,
    private val detectRows: DetectRowsUseCase,
    private val generateMission: GenerateMissionUseCase,
    private val saveField: SaveFieldUseCase,
    private val sendMission: SendMissionUseCase,
    private val piClient: PiNetworkClient = PiNetworkClient(),
    private val json: Json = Json { ignoreUnknownKeys = true },
) : ViewModel() {

    var outcome by mutableStateOf<BevOutcome>(BevOutcome.Idle)
        private set

    var isProcessing by mutableStateOf(false)
        private set

    var field by mutableStateOf(Field())
        private set

    /** Pi found over UDP broadcast (hotspot or Wi-Fi). */
    var piInfo by mutableStateOf<PiNetworkClient.PiInfo?>(null)
        private set

    /** Live mission status polled from the Pi. */
    var missionStatus by mutableStateOf(MissionStatus())
        private set

    var isDiscovering by mutableStateOf(false)
        private set

    /** Plan the Pi computed from the uploaded photo. */
    var piResult by mutableStateOf<PiImageResponse?>(null)
        private set

    /** True while the photo is being uploaded and analysed on the Pi. */
    var isUploading by mutableStateOf(false)
        private set

    private var statusJob: Job? = null

    /**
     * Run the full pipeline: BEV → row detect → mission.
     * Does NOT send to Pi — that's a separate explicit step.
     */
    fun processAndGenerate(
        imagePath: String,
        corners: FieldCorners,
        field: Field,
    ) {
        if (isProcessing) return
        viewModelScope.launch {
            isProcessing = true
            outcome = BevOutcome.Idle
            var step = "image/BGV setup"
            try {
                this@BeViewModel.field = field
                saveField(field)

                val targetW = 800
                val targetH = if (field.widthM > 0 && field.lengthM > 0) {
                    ((targetW * field.lengthM / field.widthM).toInt()).coerceIn(400, 1600)
                } else 600

                step = "BEV warp"
                val bev = generateBEV(imagePath, corners, targetW, targetH).getOrThrow()

                step = "crop-row detection"
                val rows = detectRows(bev.bevImagePath, field.totalRows)
                    .getOrThrow()

                step = "boustrophedon path planning"
                val calibr = bev.calibration.copy(
                    fieldWidthM = field.widthM,
                    fieldLengthM = field.lengthM,
                )
                val mission = generateMission(field, rows, calibr).getOrThrow()
                step = "done"

                outcome = BevOutcome.Success(
                    bevPath = bev.bevImagePath,
                    calibration = calibr,
                    rows = rows,
                    mission = mission,
                )
            } catch (e: Exception) {
                android.util.Log.e("BeViewModel", "generate failed at [$step]", e)
                outcome = BevOutcome.Error(
                    "$step failed: ${e.message ?: e.javaClass.simpleName}"
                )
            } finally {
                isProcessing = false
            }
        }
    }

    /** Serialize the mission to a JSON string (for debugging / sending). */
    fun missionToJson(mission: Mission): String =
        json.encodeToString(Mission.serializer(), mission)

    /** Explicit send step — call after generation. */
    fun sendToPi(mission: Mission, ip: String, port: Int = 8080) {
        viewModelScope.launch {
            sendMission(mission, ip, port)
                .onSuccess { /* stay in Success */ }
                .onFailure { outcome = BevOutcome.Error("Send failed: ${it.message}") }
        }
    }

    /**
     * Broadcast a discovery probe so the app finds the Pi automatically.
     * Works when the phone runs the hotspot and the Pi joined it.
     */
    fun discoverPi() {
        if (isDiscovering) return
        viewModelScope.launch {
            isDiscovering = true
            val info = piClient.discover()
            piInfo = info
            isDiscovering = false
            if (info == null) {
                outcome = BevOutcome.Error(
                    "No rover Pi found. Make sure the Pi is on the same network " +
                        "(phone hotspot) and the mission server is running."
                )
            }
        }
    }

    /**
     * Send the field photo + the 4 selected corners to the Pi.
     *
     * The Pi warps the image to BEV, detects the crop rows and builds the
     * coverage mission, then starts executing it. The phone only shows the
     * result and the live progress.
     */
    fun sendImageToPi(
        imagePath: String,
        corners: FieldCorners,
        field: Field,
        ip: String? = null,
    ) {
        if (isUploading) return
        val target = ip ?: piInfo?.host
        if (target == null) {
            outcome = BevOutcome.Error("No Pi known yet - tap Find Pi first.")
            return
        }
        viewModelScope.launch {
            isUploading = true
            outcome = BevOutcome.Idle
            try {
                val bytes = java.io.File(imagePath).readBytes()
                val response = piClient.uploadPhoto(
                    baseUrl = "http://$target:${piInfo?.port ?: 8080}",
                    imageBytes = bytes,
                    corners = corners.toList(),
                    fieldWidthM = field.widthM,
                    fieldLengthM = field.lengthM,
                    expectedRows = field.totalRows,
                    speedMps = field.speedMps,
                    laserRangeM = field.laserRangeM,
                    weedThreshold = field.weedThreshold,
                    headlandMarginM = field.headlandMarginM,
                    maxWeeds = field.maxWeeds,
                ).getOrThrow()

                piResult = response
                if (response.accepted) {
                    piInfo = PiNetworkClient.PiInfo(piInfo?.name ?: "rover-pi", target, piInfo?.port ?: 8080)
                    startStatusPolling(piInfo!!.baseUrl)
                    startSimStatusPolling(piInfo!!.baseUrl)
                } else {
                    outcome = BevOutcome.Error(response.error ?: "The Pi rejected the image")
                }
            } catch (e: Exception) {
                android.util.Log.e("BeViewModel", "upload failed", e)
                outcome = BevOutcome.Error("Upload failed: ${e.message}")
            } finally {
                isUploading = false
            }
        }
    }

    /**
     * Send the mission and start polling the Pi for progress.
     */
    fun sendAndTrack(mission: Mission, ip: String, port: Int = 8080) {
        viewModelScope.launch {
            sendMission(mission, ip, port)
                .onSuccess {
                    piInfo = PiNetworkClient.PiInfo("rover-pi", ip, port)
                    startStatusPolling(piInfo!!.baseUrl)
                }
                .onFailure { outcome = BevOutcome.Error("Send failed: ${it.message}") }
        }
    }

    /** Live 3D digital-twin render status (the Pi starts it after every upload). */
    var simStatus by mutableStateOf<com.weedlaser.bev.domain.model.Sim3dStatus?>(null)
        private set
    private var simJob: kotlinx.coroutines.Job? = null

    /** Poll `GET /sim3d` every 2 s until the render finishes. */
    private fun startSimStatusPolling(baseUrl: String) {
        simJob?.cancel()
        simStatus = null
        simJob = viewModelScope.launch {
            while (isActive) {
                piClient.fetchSimStatus(baseUrl)
                    .onSuccess { st ->
                        simStatus = st
                        if (st.state == "done" || st.state == "error") {
                            return@launch
                        }
                    }
                delay(2000)
            }
        }
    }

    /** Poll `GET /status` once a second until the mission finishes. */
    private fun startStatusPolling(baseUrl: String) {
        statusJob?.cancel()
        statusJob = viewModelScope.launch {
            while (isActive) {
                piClient.fetchStatus(baseUrl)
                    .onSuccess { status ->
                        missionStatus = status
                        if (status.finished) {
                            // a finished mission is the normal end of the
                            // flow - the Success panel already renders the
                            // DONE line. Only real errors open the error view.
                            if (status.error != null) {
                                outcome = BevOutcome.Error(status.error)
                            } else {
                                statusJob?.cancel()
                            }
                            return@launch
                        }
                    }
                delay(1000)
            }
        }
    }

    fun reset() {
        outcome = BevOutcome.Idle
        isProcessing = false
        statusJob?.cancel()
        simJob?.cancel()
        missionStatus = MissionStatus()
        simStatus = null
    }
}
