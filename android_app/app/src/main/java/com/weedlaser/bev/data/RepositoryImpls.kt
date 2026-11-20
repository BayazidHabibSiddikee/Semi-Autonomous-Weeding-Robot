package com.weedlaser.bev.data

import android.content.Context
import android.graphics.BitmapFactory
import android.graphics.ImageFormat
import android.hardware.camera2.CameraCharacteristics
import android.hardware.camera2.CameraManager
import androidx.camera.core.CameraSelector
import androidx.camera.core.ImageCapture
import androidx.camera.core.ImageCaptureException
import androidx.camera.core.Preview
import androidx.camera.lifecycle.ProcessCameraProvider
import androidx.camera.view.PreviewView
import androidx.core.content.ContextCompat
import androidx.lifecycle.LifecycleOwner
import com.weedlaser.bev.core.opencv.OpenCVProcessor
import com.weedlaser.bev.core.opencv.RowDetector
import com.weedlaser.bev.domain.model.Field
import com.weedlaser.bev.domain.model.FieldCorners
import com.weedlaser.bev.domain.model.HomographyCalibration
import com.weedlaser.bev.domain.model.Mission
import com.weedlaser.bev.domain.model.OriginCorner
import com.weedlaser.bev.domain.model.RowDetectionResult
import com.weedlaser.bev.domain.repository.CameraInfo
import com.weedlaser.bev.domain.repository.CameraRepository
import com.weedlaser.bev.domain.repository.FieldRepository
import com.weedlaser.bev.domain.repository.HomographyResult
import com.weedlaser.bev.domain.repository.ImageProcessingRepository
import com.weedlaser.bev.domain.usecase.BoustrophedonGenerator
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.withContext
import java.io.File
import kotlin.coroutines.resume

/**
 * In-memory implementation of [FieldRepository] (retained for unit tests).
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
 * Persistent [FieldRepository] backed by Android SharedPreferences so field
 * dimensions and row configuration survive app restarts.
 */
class SharedPreferencesFieldRepository(context: Context) : FieldRepository {
    private val prefs = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
    private val _field = MutableStateFlow(readFromPrefs())

    override suspend fun getField(): Result<Field> = Result.success(_field.value)

    override suspend fun saveField(field: Field): Result<Unit> = runCatching {
        prefs.edit()
            .putString(KEY_WIDTH_M, field.widthM.toString())
            .putString(KEY_LENGTH_M, field.lengthM.toString())
            .putInt(KEY_TOTAL_ROWS, field.totalRows)
            .putString(KEY_ROW_SPACING_M, field.rowSpacingM.toString())
            .putString(KEY_ORIGIN_CORNER, field.originCorner.name)
            .apply()
        _field.value = field
    }

    override fun observeField(): StateFlow<Field> = _field

    private fun readFromPrefs(): Field {
        val defaults = Field()
        val widthM = prefs.getString(KEY_WIDTH_M, null)?.toDoubleOrNull()?.takeIf { it > 0.0 }
            ?: defaults.widthM
        val lengthM = prefs.getString(KEY_LENGTH_M, null)?.toDoubleOrNull()?.takeIf { it > 0.0 }
            ?: defaults.lengthM
        val totalRows = prefs.getInt(KEY_TOTAL_ROWS, defaults.totalRows).coerceAtLeast(1)
        val rowSpacingM = prefs.getString(KEY_ROW_SPACING_M, null)?.toDoubleOrNull()?.takeIf { it > 0.0 }
            ?: defaults.rowSpacingM
        val origin = prefs.getString(KEY_ORIGIN_CORNER, null)
            ?.let { runCatching { OriginCorner.valueOf(it) }.getOrNull() }
            ?: defaults.originCorner
        return Field(
            widthM = widthM,
            lengthM = lengthM,
            totalRows = totalRows,
            rowSpacingM = rowSpacingM,
            originCorner = origin,
        )
    }

    companion object {
        private const val PREFS_NAME = "bev_field_prefs"
        private const val KEY_WIDTH_M = "width_m"
        private const val KEY_LENGTH_M = "length_m"
        private const val KEY_TOTAL_ROWS = "total_rows"
        private const val KEY_ROW_SPACING_M = "row_spacing_m"
        private const val KEY_ORIGIN_CORNER = "origin_corner"
    }
}

/**
 * OpenCV-backed implementation of [ImageProcessingRepository] with pure-Kotlin Bitmap fallback.
 */
class OpenCVImageProcessingRepository(
    private val opencv: OpenCVProcessor,
    private val rowDetector: RowDetector,
    private val generator: BoustrophedonGenerator,
    private val outputDir: File,
) : ImageProcessingRepository {

    init {
        if (!opencv.init()) {
            android.util.Log.w(
                "OpenCVRepo",
                "OpenCV native library unavailable; falling back to pure-Kotlin Bitmap processing"
            )
        }
        outputDir.mkdirs()
    }

    override suspend fun computeHomographyAndWarp(
        imagePath: String,
        corners: FieldCorners,
        outputWidth: Int,
        outputHeight: Int,
    ): Result<HomographyResult> {
        return withContext(Dispatchers.Default) {
            runCatching {
                val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
                BitmapFactory.decodeFile(imagePath, bounds)
                require(bounds.outWidth > 0 && bounds.outHeight > 0) {
                    "Could not read source image dimensions: $imagePath"
                }
                require(corners.isValidForImage(bounds.outWidth.toFloat(), bounds.outHeight.toFloat())) {
                    "Selected corners must lie within image bounds (${bounds.outWidth}x${bounds.outHeight}), be ordered clockwise (TL→TR→BR→BL), and form a convex quadrilateral"
                }

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
                    fieldWidthM = 0.0,
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
            rowDetector.detect(
                bevPath = bevImagePath,
                expectedCount = expectedRows,
                useNativeOpenCV = opencv.isNativeAvailable(),
            )
        }

    override suspend fun generateMission(
        field: Field,
        rowDetection: RowDetectionResult,
        calibration: HomographyCalibration,
    ): Result<Mission> = runCatching {
        require(rowDetection.rowCentersX.isNotEmpty()) {
            "Cannot generate mission without detected crop rows"
        }
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
 * Real CameraX-backed [CameraRepository] supporting device camera enumeration,
 * live PreviewView binding, and high-resolution JPEG capture.
 */
class CameraXRepository(
    private val context: Context,
    private val outputDir: File,
) : CameraRepository {

    private var cameraProvider: ProcessCameraProvider? = null
    private var imageCapture: ImageCapture? = null

    init {
        outputDir.mkdirs()
    }

    override fun startPreview(surfaceProvider: PreviewView): Result<Unit> = runCatching {
        val lifecycleOwner = surfaceProvider.context as? LifecycleOwner
            ?: error("PreviewView context must be a LifecycleOwner")

        val future = ProcessCameraProvider.getInstance(context)
        future.addListener({
            runCatching {
                val provider = future.get()
                val preview = Preview.Builder().build().also {
                    it.setSurfaceProvider(surfaceProvider.surfaceProvider)
                }
                val capture = ImageCapture.Builder()
                    .setCaptureMode(ImageCapture.CAPTURE_MODE_MAXIMIZE_QUALITY)
                    .build()

                provider.unbindAll()
                provider.bindToLifecycle(
                    lifecycleOwner,
                    CameraSelector.DEFAULT_BACK_CAMERA,
                    preview,
                    capture,
                )
                cameraProvider = provider
                imageCapture = capture
            }
        }, ContextCompat.getMainExecutor(context))
    }

    override fun stopPreview(): Result<Unit> = runCatching {
        cameraProvider?.unbindAll()
        imageCapture = null
    }

    override suspend fun capturePhoto(): Result<String> = suspendCancellableCoroutine { cont ->
        val capture = imageCapture
        if (capture == null) {
            cont.resume(Result.failure(IllegalStateException("Camera preview not started; call startPreview() first")))
            return@suspendCancellableCoroutine
        }
        val outFile = File(outputDir, "camerax_${System.currentTimeMillis()}.jpg")
        val outputOptions = ImageCapture.OutputFileOptions.Builder(outFile).build()
        capture.takePicture(
            outputOptions,
            ContextCompat.getMainExecutor(context),
            object : ImageCapture.OnImageSavedCallback {
                override fun onImageSaved(outputFileResults: ImageCapture.OutputFileResults) {
                    if (cont.isActive) cont.resume(Result.success(outFile.absolutePath))
                }

                override fun onError(exception: ImageCaptureException) {
                    if (cont.isActive) cont.resume(Result.failure(exception))
                }
            }
        )
    }

    override suspend fun getAvailableCameras(): Result<List<CameraInfo>> = withContext(Dispatchers.IO) {
        runCatching {
            val manager = context.getSystemService(Context.CAMERA_SERVICE) as CameraManager
            manager.cameraIdList.mapNotNull { id ->
                val chars = manager.getCameraCharacteristics(id)
                val lens = chars.get(CameraCharacteristics.LENS_FACING) ?: return@mapNotNull null
                val facing = when (lens) {
                    CameraCharacteristics.LENS_FACING_BACK -> CameraSelector.LENS_FACING_BACK
                    CameraCharacteristics.LENS_FACING_FRONT -> CameraSelector.LENS_FACING_FRONT
                    else -> return@mapNotNull null
                }
                val map = chars.get(CameraCharacteristics.SCALER_STREAM_CONFIGURATION_MAP)
                val maxSize = map?.getOutputSizes(ImageFormat.JPEG)
                    ?.maxByOrNull { it.width.toLong() * it.height.toLong() }
                    ?: android.util.Size(1920, 1080)
                CameraInfo(id = id, facing = facing, maxResolution = maxSize)
            }
        }
    }
}
