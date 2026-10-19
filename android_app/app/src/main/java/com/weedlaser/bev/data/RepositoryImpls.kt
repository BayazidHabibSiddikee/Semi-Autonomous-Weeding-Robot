package com.weedlaser.bev.data

import com.weedlaser.bev.core.opencv.FieldAnalyzer
import com.weedlaser.bev.core.opencv.OpenCVProcessor
import com.weedlaser.bev.core.opencv.RowDetector
import com.weedlaser.bev.domain.model.Field
import com.weedlaser.bev.domain.model.FieldCorners
import com.weedlaser.bev.domain.model.HomographyCalibration
import com.weedlaser.bev.domain.model.Mission
import com.weedlaser.bev.domain.model.RowDetectionResult
import com.weedlaser.bev.domain.repository.FieldRepository
import com.weedlaser.bev.domain.repository.HomographyResult
import com.weedlaser.bev.domain.repository.ImageProcessingRepository
import com.weedlaser.bev.domain.usecase.BoustrophedonGenerator
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.withContext
import java.io.File

/**
 * In-memory implementation of [FieldRepository].
 *
 * For persistence, replace [MutableStateFlow] with a Room entity or
 * SharedPreferences-backed source. The UI observes [field].
 */
class InMemoryFieldRepository : FieldRepository {
    private val _field = MutableStateFlow(Field())
    override suspend fun getField() = Result.success(_field.value)
    override suspend fun saveField(field: Field): Result<Unit> {
        _field.value = field
        return Result.success(Unit)
    }
    override fun observeField(): StateFlow<Field> = _field
}

/**
 * OpenCV-backed implementation of [ImageProcessingRepository].
 *
 * @param opencv Native OpenCV wrapper
 * @param rowDetector Green-vegetation row detector
 * @param generator Boustrophedon path generator
 * @param outputDir Where to write intermediate BEV images
 */
class OpenCVImageProcessingRepository(
    private val opencv: OpenCVProcessor,
    private val rowDetector: RowDetector,
    private val fieldAnalyzer: FieldAnalyzer,
    private val generator: BoustrophedonGenerator,
    private val outputDir: File,
) : ImageProcessingRepository {

    init {
        require(opencv.init()) { "Failed to load OpenCV native library" }
        outputDir.mkdirs()
    }

    override suspend fun computeHomographyAndWarp(
        imagePath: String,
        corners: FieldCorners,
        outputWidth: Int,
        outputHeight: Int,
    ): Result<HomographyResult> {
        require(corners.isValid()) { "Selected corners do not form a valid quadrilateral" }
        return withContext(Dispatchers.Default) {
            runCatching {
                val srcPoints = corners.toList().map { org.opencv.core.Point(it.x.toDouble(), it.y.toDouble()) }
                val bevName = "bev_${System.currentTimeMillis()}.jpg"
                val bevPath = File(outputDir, bevName).absolutePath
                val matrix = opencv.warpToBEV(
                    inputPath = imagePath,
                    outputPath = bevPath,
                    srcCorners = srcPoints,
                    outputW = outputWidth,
                    outputH = outputHeight,
                ).getOrThrow()

                val calibration = HomographyCalibration(
                    sourceCorners = corners,
                    destWidth = outputWidth,
                    destHeight = outputHeight,
                    matrix = matrix.toList(),
                    fieldWidthM = 0.0,   // caller fills in
                    fieldLengthM = 0.0,
                )
                HomographyResult(bevPath, calibration)
            }
        }
    }

    override suspend fun detectRows(
        bevImagePath: String,
        expectedRows: Int?,
    ): Result<RowDetectionResult> =
        withContext(Dispatchers.Default) {
            // New agricultural analyzer (Otsu-ExG + segment rows + field corners).
            // Falls back to the previous peak-based detector if it fails.
            fieldAnalyzer.analyze(bevImagePath, expectedRows)
                .recoverCatching { rowDetector.detect(bevImagePath, expectedRows).getOrThrow() }
        }

    override suspend fun generateMission(
        field: Field,
        rowDetection: RowDetectionResult,
        calibration: HomographyCalibration,
    ): Result<Mission> = runCatching {
        generator.generate(
            field = field.copy(
                totalRows = if (field.totalRows > 0) field.totalRows else rowDetection.rowCount,
            ),
            rows = rowDetection,
            calibration = calibration,
        )
    }
}

/**
 * Basic camera repository for photo file handling
 */
class LocalCameraRepository : com.weedlaser.bev.domain.repository.CameraRepository {
    override suspend fun capturePhoto(): Result<String> = Result.failure(
        UnsupportedOperationException("Use in-app CameraX or PhotoPicker")
    )
    override fun startPreview(surfaceProvider: androidx.camera.view.PreviewView): Result<Unit> =
        Result.success(Unit)
    override fun stopPreview(): Result<Unit> = Result.success(Unit)
    override suspend fun getAvailableCameras(): Result<List<com.weedlaser.bev.domain.repository.CameraInfo>> =
        Result.success(emptyList())
}
