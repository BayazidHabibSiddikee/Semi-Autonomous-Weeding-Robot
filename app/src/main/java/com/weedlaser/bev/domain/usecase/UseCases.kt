package com.weedlaser.bev.domain.usecase

import com.weedlaser.bev.domain.model.Field
import com.weedlaser.bev.domain.model.FieldCorners
import com.weedlaser.bev.domain.model.HomographyCalibration
import com.weedlaser.bev.domain.model.Mission
import com.weedlaser.bev.domain.model.RowDetectionResult
import com.weedlaser.bev.domain.repository.CameraRepository
import com.weedlaser.bev.domain.repository.DiscoveredDevice
import com.weedlaser.bev.domain.repository.FieldRepository
import com.weedlaser.bev.domain.repository.HomographyResult
import com.weedlaser.bev.domain.repository.ImageProcessingRepository
import com.weedlaser.bev.domain.repository.MissionCommunicationRepository
import kotlinx.coroutines.flow.Flow

/**
 * Get current field configuration
 */
class GetFieldUseCase(
    private val fieldRepository: FieldRepository
) {
    operator fun invoke(): Flow<Field> = fieldRepository.observeField()

    suspend fun getOnce() = fieldRepository.getField()
}

/**
 * Save field configuration
 */
class SaveFieldUseCase(
    private val fieldRepository: FieldRepository
) {
    suspend operator fun invoke(field: Field) = fieldRepository.saveField(field)
}

/**
 * Capture photo using camera
 */
class CapturePhotoUseCase(
    private val cameraRepository: CameraRepository
) {
    suspend operator fun invoke(): Result<String> = cameraRepository.capturePhoto()
}

/**
 * Compute homography and generate BEV from captured image
 */
class GenerateBEVUseCase(
    private val imageProcessingRepository: ImageProcessingRepository
) {
    suspend operator fun invoke(
        imagePath: String,
        corners: FieldCorners,
        outputWidth: Int = 800,
        outputHeight: Int = 600,
    ): Result<HomographyResult> = imageProcessingRepository.computeHomographyAndWarp(
        imagePath, corners, outputWidth, outputHeight
    )
}

/**
 * Detect crop rows in BEV image
 */
class DetectRowsUseCase(
    private val imageProcessingRepository: ImageProcessingRepository
) {
    suspend operator fun invoke(bevImagePath: String, expectedRows: Int? = null): Result<RowDetectionResult> =
        imageProcessingRepository.detectRows(bevImagePath, expectedRows)
}

/**
 * Generate mission from field config and row detection
 */
class GenerateMissionUseCase(
    private val imageProcessingRepository: ImageProcessingRepository
) {
    suspend operator fun invoke(
        field: Field,
        rowDetection: RowDetectionResult,
        calibration: HomographyCalibration
    ): Result<Mission> = imageProcessingRepository.generateMission(
        field, rowDetection, calibration
    )
}

/**
 * Send mission to Raspberry Pi
 */
class SendMissionUseCase(
    private val missionCommRepository: MissionCommunicationRepository
) {
    suspend operator fun invoke(
        mission: Mission,
        targetIp: String,
        port: Int = 8080
    ): Result<Unit> = missionCommRepository.sendMission(mission, targetIp, port)
}

/**
 * Test connection to Pi
 */
class TestPiConnectionUseCase(
    private val missionCommRepository: MissionCommunicationRepository
) {
    suspend operator fun invoke(targetIp: String, port: Int = 8080): Result<Boolean> =
        missionCommRepository.testConnection(targetIp, port)
}

/**
 * Discover Pi devices on network
 */
class DiscoverPiDevicesUseCase(
    private val missionCommRepository: MissionCommunicationRepository
) {
    suspend operator fun invoke(): Result<List<DiscoveredDevice>> =
        missionCommRepository.discoverDevices()
}