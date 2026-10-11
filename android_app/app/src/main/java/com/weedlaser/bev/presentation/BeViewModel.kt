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
import com.weedlaser.bev.domain.usecase.DetectRowsUseCase
import com.weedlaser.bev.domain.usecase.GenerateBEVUseCase
import com.weedlaser.bev.domain.usecase.GenerateMissionUseCase
import com.weedlaser.bev.domain.usecase.SaveFieldUseCase
import com.weedlaser.bev.domain.usecase.SendMissionUseCase
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
    private val json: Json = Json { ignoreUnknownKeys = true },
) : ViewModel() {

    var outcome by mutableStateOf<BevOutcome>(BevOutcome.Idle)
        private set

    var isProcessing by mutableStateOf(false)
        private set

    var field by mutableStateOf(Field())
        private set

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
            try {
                this@BeViewModel.field = field
                saveField(field)

                val targetW = 800
                val targetH = if (field.widthM > 0 && field.lengthM > 0) {
                    ((targetW * field.lengthM / field.widthM).toInt()).coerceIn(400, 1600)
                } else 600

                val bev = generateBEV(imagePath, corners, targetW, targetH).getOrThrow()

                val rows = detectRows(bev.bevImagePath, field.totalRows)
                    .getOrThrow()

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

    fun reset() {
        outcome = BevOutcome.Idle
        isProcessing = false
    }
}
