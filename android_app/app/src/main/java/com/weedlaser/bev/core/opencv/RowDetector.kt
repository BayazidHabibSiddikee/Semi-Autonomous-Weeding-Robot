package com.weedlaser.bev.core.opencv

import org.opencv.core.Core
import org.opencv.core.Mat
import org.opencv.core.MatOfInt
import org.opencv.core.Scalar
import org.opencv.core.Size
import org.opencv.imgcodecs.Imgcodecs
import org.opencv.imgproc.Imgproc
import com.weedlaser.bev.domain.model.RowDetectionResult
import kotlin.math.abs

/**
 * Detects crop rows in a BEV image by thresholding for green vegetation
 * and clustering the column projections into distinct row bands.
 */
class RowDetector {

    data class DetectionParams(
        val hsvGreenLow: IntArray = intArrayOf(35, 40, 40),
        val hsvGreenHigh: IntArray = intArrayOf(85, 255, 255),
        val closeKernelSize: Int = 7,
        val clusterTolerancePx: Int = 20,
        val minGreenColumnRatio: Float = 0.08f,
    )

    private val params = DetectionParams()

    /**
     * Analyze a BEV image and return detected row center X positions.
     *
     * @param bevPath Path to the BEV (top-down) image
     * @param expectedCount Optional expected row count used for confidence
     * @return [RowDetectionResult] with pixel coordinates and confidence
     */
    fun detect(bevPath: String, expectedCount: Int? = null): Result<RowDetectionResult> =
        runCatching {
            val mat = Imgcodecs.imread(bevPath, Imgcodecs.IMREAD_COLOR)
            require(!mat.empty()) { "Failed to read BEV: $bevPath" }

            val hsv = Mat()
            Imgproc.cvtColor(mat, hsv, Imgproc.COLOR_BGR2HSV)

            val mask = Mat()
            val low = Scalar(params.hsvGreenLow[0].toDouble(), params.hsvGreenLow[1].toDouble(), params.hsvGreenLow[2].toDouble())
            val high = Scalar(params.hsvGreenHigh[0].toDouble(), params.hsvGreenHigh[1].toDouble(), params.hsvGreenHigh[2].toDouble())
            Core.inRange(hsv, low, high, mask)

            val kernelSize = Size(params.closeKernelSize.toDouble(), params.closeKernelSize.toDouble())
            val kernel = Imgproc.getStructuringElement(Imgproc.MORPH_ELLIPSE, kernelSize)
            val closed = Mat()
            Imgproc.morphologyEx(mask, closed, Imgproc.MORPH_CLOSE, kernel)

            val width = closed.cols()
            val height = closed.rows()

            // Column projection: fraction of green pixels per column
            val colGreen = FloatArray(width) { c ->
                var count = 0
                for (r in 0 until height) {
                    if (closed.get(r, c)[0].toInt() > 0) count++
                }
                count / height.toFloat()
            }

            val bands = findBands(colGreen, params.minGreenColumnRatio)
            val centers = bands.map { (start, end) -> (start + end) / 2f }
            val clustered = clusterCenters(centers, params.clusterTolerancePx)

            val spacing = if (clustered.size >= 2) {
                (1 until clustered.size)
                    .map { abs(clustered[it] - clustered[it - 1]) }
                    .average().toFloat()
            } else 0f

            val confidence = computeConfidence(clustered, expectedCount)

            if (clustered.isEmpty()) {
                error("No crop rows detected in BEV. Improve lighting or corner selection.")
            }

            mat.release(); hsv.release(); mask.release()
            closed.release(); kernel.release()

            RowDetectionResult(
                rowCount = clustered.size,
                rowCentersX = clustered,
                rowSpacingPx = spacing,
                confidence = confidence,
                bevWidth = width,
                bevHeight = height,
            )
        }

    private fun findBands(colGreen: FloatArray, threshold: Float): List<Pair<Int, Int>> {
        val bands = mutableListOf<Pair<Int, Int>>()
        var start: Int? = null
        for (i in colGreen.indices) {
            if (colGreen[i] >= threshold) {
                if (start == null) start = i
            } else {
                if (start != null) { bands.add(start!! to (i - 1)); start = null }
            }
        }
        if (start != null) bands.add(start!! to colGreen.lastIndex)
        return bands
    }

    private fun clusterCenters(centers: List<Float>, tolerance: Int): List<Float> {
        if (centers.isEmpty()) return emptyList()
        val sorted = centers.sorted()
        val result = mutableListOf(sorted.first())
        for (c in sorted.drop(1)) {
            val last = result.last()
            if (abs(c - last) <= tolerance) {
                result[result.lastIndex] = (c + last) / 2f
            } else {
                result.add(c)
            }
        }
        return result
    }

    private fun computeConfidence(centers: List<Float>, expected: Int?): Float {
        var score = 0.5f
        if (centers.size >= 2) {
            val diffs = (1 until centers.size).map { abs(centers[it] - centers[it - 1]) }
            val avg = diffs.average()
            val maxDev = (diffs.map { abs(it - avg) }.maxOrNull()) ?: 0.0
            val uniformity = 1f - (maxDev / (avg + 0.001)).toFloat().coerceIn(0f, 1f)
            score += uniformity * 0.3f
        }
        if (expected != null && expected > 0) {
            val ratio = centers.size.toFloat() / expected
            score += (1f - abs(ratio - 1f)).coerceIn(0f, 1f) * 0.2f
        }
        return score.coerceIn(0f, 1f)
    }
}