package com.weedlaser.bev.domain.repository

import com.weedlaser.bev.domain.model.Field
import com.weedlaser.bev.domain.model.FieldCorners
import com.weedlaser.bev.domain.model.HomographyCalibration
import com.weedlaser.bev.domain.model.Mission
import com.weedlaser.bev.domain.model.RowDetectionResult
import kotlinx.coroutines.flow.Flow

/**
 * Repository for field-related operations
 */
interface FieldRepository {
    /**
     * Get the current field configuration
     */
    suspend fun getField(): Result<Field>
    
    /**
     * Save field configuration
     */
    suspend fun saveField(field: Field): Result<Unit>
    
    /**
     * Observe field changes
     */
    fun observeField(): Flow<Field>
}

/**
 * Repository for image processing operations
 */
interface ImageProcessingRepository {
    /**
     * Compute homography from 4 corner points and warp image to BEV
     */
    suspend fun computeHomographyAndWarp(
        imagePath: String,
        corners: FieldCorners,
        outputWidth: Int,
        outputHeight: Int
    ): Result<HomographyResult>
    
    /**
     * Detect crop rows in BEV image
     *
     * @param expectedRows Optional expected row count used for confidence scoring
     */
    suspend fun detectRows(bevImagePath: String, expectedRows: Int? = null): Result<RowDetectionResult>
    
    /**
     * Generate mission from field and row detection
     */
    suspend fun generateMission(
        field: Field,
        rowDetection: RowDetectionResult,
        calibration: HomographyCalibration
    ): Result<Mission>
}

data class HomographyResult(
    val bevImagePath: String,
    val calibration: HomographyCalibration,
)

/**
 * Repository for mission communication with Raspberry Pi
 */
interface MissionCommunicationRepository {
    /**
     * Send mission to Pi via WiFi/Bluetooth
     */
    suspend fun sendMission(mission: Mission, targetIp: String, port: Int): Result<Unit>
    
    /**
     * Test connection to Pi
     */
    suspend fun testConnection(targetIp: String, port: Int): Result<Boolean>
    
    /**
     * Discover Pi devices on network
     */
    suspend fun discoverDevices(): Result<List<DiscoveredDevice>>
}

data class DiscoveredDevice(
    val name: String,
    val ipAddress: String,
    val port: Int,
    val deviceType: DeviceType = DeviceType.UNKNOWN,
)

enum class DeviceType {
    RASPBERRY_PI, ESP32, UNKNOWN
}

/**
 * Repository for camera operations
 */
interface CameraRepository {
    /**
     * Capture high-resolution photo
     */
    suspend fun capturePhoto(): Result<String> // Returns file path
    
    /**
     * Start camera preview
     */
    fun startPreview(surfaceProvider: androidx.camera.view.PreviewView): Result<Unit>
    
    /**
     * Stop camera preview
     */
    fun stopPreview(): Result<Unit>
    
    /**
     * Get available cameras
     */
    suspend fun getAvailableCameras(): Result<List<CameraInfo>>
}

data class CameraInfo(
    val id: String,
    val facing: Int, // CameraSelector.LENS_FACING_BACK/FRONT
    val maxResolution: android.util.Size,
)