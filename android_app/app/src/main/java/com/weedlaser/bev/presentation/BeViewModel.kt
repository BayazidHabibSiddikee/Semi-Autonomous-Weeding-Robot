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
import com.weedlaser.bev.domain.model.RowDetectionResult
import com.weedlaser.bev.domain.repository.DiscoveredDevice
import com.weedlaser.bev.domain.usecase.DetectRowsUseCase
import com.weedlaser.bev.domain.usecase.DiscoverPiDevicesUseCase
import com.weedlaser.bev.domain.usecase.GenerateBEVUseCase
import com.weedlaser.bev.domain.usecase.GenerateMissionUseCase
import com.weedlaser.bev.domain.usecase.GetFieldUseCase
import com.weedlaser.bev.domain.usecase.SaveFieldUseCase
import com.weedlaser.bev.domain.usecase.SendMissionUseCase
import com.weedlaser.bev.domain.usecase.TestPiConnectionUseCase
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
 * Non-destructive status for Raspberry Pi connection tests & mission uploads.
 */
sealed interface PiTransferState {
    object Idle : PiTransferState
    object Busy : PiTransferState
    data class Success(val message: String) : PiTransferState
    data class Error(val message: String) : PiTransferState
}

/**
 * ViewModel driving the full pipeline:
 * capture → corner selection → BEV → row detection (with confidence gate) → mission → send.
 */
class BeViewModel(
    private val getField: GetFieldUseCase,
    private val generateBEV: GenerateBEVUseCase,
    private val detectRows: DetectRowsUseCase,
    private val generateMission: GenerateMissionUseCase,
    private val saveField: SaveFieldUseCase,
    private val sendMission: SendMissionUseCase,
    private val testPiConnection: TestPiConnectionUseCase,
    private val discoverPiDevices: DiscoverPiDevicesUseCase,
    private val json: Json = Json {
        ignoreUnknownKeys = true
        encodeDefaults = true
        prettyPrint = true
    },
) : ViewModel() {

    var outcome by mutableStateOf<BevOutcome>(BevOutcome.Idle)
        private set

    var isProcessing by mutableStateOf(false)
        private set

    var piTransferState by mutableStateOf<PiTransferState>(PiTransferState.Idle)
        private set

    var discoveredDevices by mutableStateOf<List<DiscoveredDevice>>(emptyList())
        private set

    var field by mutableStateOf(Field())
        private set

    init {
        viewModelScope.launch {
            getField.getOnce().onSuccess { saved ->
                field = saved
            }
        }
    }

    fun updateField(newField: Field) {
        field = newField
        viewModelScope.launch {
            saveField(newField)
        }
    }

    /**
     * Run the full pipeline: BEV → row detect → confidence gate → mission.
     * Rejects low-confidence row detections rather than fabricating an unsafe mission.
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
            piTransferState = PiTransferState.Idle
            try {
                require(field.widthM > 0.0 && field.lengthM > 0.0) {
                    "Field width and length must be greater than 0"
                }
                require(field.totalRows > 0) {
                    "Total rows must be at least 1"
                }

                this@BeViewModel.field = field
                saveField(field)

                val targetW = 800
                val targetH = ((targetW * field.lengthM / field.widthM).toInt()).coerceIn(400, 1600)

                val bev = generateBEV(imagePath, corners, targetW, targetH).getOrThrow()

                val rows = detectRows(bev.bevImagePath, field.totalRows)
                    .getOrThrow()

                // Confidence gate: prevent generating an executable mission from non-field or blurry images
                if (rows.rowCentersX.isEmpty() || rows.detectedRowCount < MIN_DETECTED_ROWS || rows.confidence < MIN_ROW_CONFIDENCE) {
                    val pct = (rows.confidence * 100).toInt()
                    outcome = BevOutcome.Error(
                        "Row detection confidence too low ($pct%, detected ${rows.detectedRowCount}/${field.totalRows} rows). " +
                            "Please recapture a clearer crop-row photo or adjust the 4 field corners."
                    )
                    return@launch
                }

                val calibr = bev.calibration.copy(
                    fieldWidthM = field.widthM,
                    fieldLengthM = field.lengthM,
                )
                val mission = generateMission(field, rows, calibr).getOrThrow()

                outcome = BevOutcome.Success(
                    bevPath = bev.bevImagePath,
                    calibration = calibr,
                    rows = rows,
                    mission = mission,
                )
            } catch (e: Exception) {
                outcome = BevOutcome.Error(e.message ?: "Unknown error")
            } finally {
                isProcessing = false
            }
        }
    }

    /** Serialize the mission to a formatted JSON string (with all defaults included). */
    fun missionToJson(mission: Mission): String =
        json.encodeToString(Mission.serializer(), mission)

    /** Discover Raspberry Pi robots on the local Wi-Fi/hotspot via UDP + /health probe. */
    fun discoverRobots() {
        viewModelScope.launch {
            piTransferState = PiTransferState.Busy
            discoverPiDevices()
                .onSuccess { devices ->
                    discoveredDevices = devices
                    piTransferState = if (devices.isNotEmpty()) {
                        PiTransferState.Success("Found ${devices.size} robot(s) on network")
                    } else {
                        PiTransferState.Error("No robots discovered on LAN (is mission_receiver.py running?)")
                    }
                }
                .onFailure {
                    piTransferState = PiTransferState.Error("Discovery failed: ${it.message}")
                }
        }
    }

    /** Test HTTP /health reachability to the Raspberry Pi without altering the generated mission. */
    fun testConnection(ip: String, port: Int = 8080) {
        viewModelScope.launch {
            piTransferState = PiTransferState.Busy
            testPiConnection(ip, port)
                .onSuccess { connected ->
                    piTransferState = if (connected) {
                        PiTransferState.Success("Connected to $ip:$port")
                    } else {
                        PiTransferState.Error("Could not reach $ip:$port")
                    }
                }
                .onFailure {
                    piTransferState = PiTransferState.Error("Connection failed: ${it.message}")
                }
        }
    }

    /** Explicit send step — keeps generated BEV & mission visible on failure. */
    fun sendToPi(mission: Mission, ip: String, port: Int = 8080) {
        viewModelScope.launch {
            piTransferState = PiTransferState.Busy
            sendMission(mission, ip, port)
                .onSuccess {
                    piTransferState = PiTransferState.Success("Mission acknowledged by $ip:$port")
                }
                .onFailure {
                    piTransferState = PiTransferState.Error("Send failed: ${it.message}")
                }
        }
    }

    fun reset() {
        outcome = BevOutcome.Idle
        piTransferState = PiTransferState.Idle
        isProcessing = false
    }

    companion object {
        const val MIN_ROW_CONFIDENCE = 0.45f
        const val MIN_DETECTED_ROWS = 2
    }
}
