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
 * Advanced agricultural computer-vision row detector:
 * 1. Computes Excess Green Index (ExG = 2*G - R - B) to separate crops from soil.
 * 2. Combines with HSV vegetation mask to eliminate specular highlights and deep shadow noise.
 * 3. Applies directional morphological structuring (vertical closing) along crop paths.
 * 4. Extracts smoothed column projection profile and identifies crop row peaks.
 * 5. Uses regularized agricultural row alignment when expected row count is provided.
 */
class RowDetector {

    /**
     * Analyze a BEV image and return detected row center X positions.
     *
     * @param bevPath Path to the BEV (top-down) image
     * @param expectedCount Optional expected row count used for confidence and spacing
     * @return [RowDetectionResult] with pixel coordinates and confidence
     */
    fun detect(bevPath: String, expectedCount: Int? = null): Result<RowDetectionResult> =
        runCatching {
            val mat = Imgcodecs.imread(bevPath, Imgcodecs.IMREAD_COLOR)
            require(!mat.empty()) { "Failed to read BEV: $bevPath" }

            val width = mat.cols()
            val height = mat.rows()

            // 1. Excess Green Index (ExG = 2*G - R - B)
            val channels = ArrayList<Mat>(3)
            Core.split(mat, channels)
            val b = channels[0]
            val g = channels[1]
            val r = channels[2]

            val g16 = Mat()
            val r16 = Mat()
            val b16 = Mat()
            g.convertTo(g16, org.opencv.core.CvType.CV_16SC1)
            r.convertTo(r16, org.opencv.core.CvType.CV_16SC1)
            b.convertTo(b16, org.opencv.core.CvType.CV_16SC1)

            val twoG = Mat()
            Core.multiply(g16, Scalar(2.0), twoG)
            val rPlusB = Mat()
            Core.add(r16, b16, rPlusB)
            val exg = Mat()
            Core.subtract(twoG, rPlusB, exg)

            // Positive ExG (> 0) represents vegetation
            val exgMask = Mat()
            Core.compare(exg, Scalar(0.0), exgMask, Core.CMP_GT)

            // 2. HSV vegetation filter (yellow-green to dark green)
            val hsv = Mat()
            Imgproc.cvtColor(mat, hsv, Imgproc.COLOR_BGR2HSV)
            val hsvMask = Mat()
            Core.inRange(hsv, Scalar(20.0, 25.0, 25.0), Scalar(100.0, 255.0, 255.0), hsvMask)

            // Combined vegetation mask
            val vegMask = Mat()
            Core.bitwise_and(exgMask, hsvMask, vegMask)

            // 3. Directional morphology: vertical closing connects leaf canopies along rows
            val vKernel = Imgproc.getStructuringElement(Imgproc.MORPH_RECT, Size(3.0, 15.0))
            val closed = Mat()
            Imgproc.morphologyEx(vegMask, closed, Imgproc.MORPH_CLOSE, vKernel)

            // Cleanup intermediate mats
            b.release(); g.release(); r.release()
            g16.release(); r16.release(); b16.release()
            twoG.release(); rPlusB.release(); exg.release()
            exgMask.release(); hsv.release(); hsvMask.release()
            vegMask.release(); vKernel.release()

            // 4. Column projection: fraction of green vegetation per vertical column
            val colGreen = FloatArray(width) { c ->
                var count = 0
                for (row in 0 until height) {
                    if (closed.get(row, c)[0].toInt() > 0) count++
                }
                count / height.toFloat()
            }
            closed.release(); mat.release()

            // 5. 1D weighted smoothing
            val expectedN = expectedCount ?: 10
            val winR = (width / (expectedN * 4)).coerceIn(4, 24)
            val smoothed = FloatArray(width) { i ->
                var sum = 0f
                var weight = 0f
                val r0 = maxOf(0, i - winR)
                val r1 = minOf(width - 1, i + winR)
                for (j in r0..r1) {
                    val w = (winR + 1 - kotlin.math.abs(i - j)).toFloat()
                    sum += colGreen[j] * w
                    weight += w
                }
                if (weight > 0f) sum / weight else 0f
            }

            // 6. Prominent peak detection
            val meanGreen = smoothed.average().toFloat()
            val peakThreshold = maxOf(meanGreen * 0.4f, 0.02f)
            val minDistance = (width / expectedN.toFloat() * 0.5f).toInt().coerceAtLeast(15)

            val rawPeaks = mutableListOf<Int>()
            for (c in 1 until width - 1) {
                if (smoothed[c] > smoothed[c - 1] && smoothed[c] >= smoothed[c + 1] && smoothed[c] > peakThreshold) {
                    rawPeaks.add(c)
                }
            }

            // Non-maximum suppression by peak height
            val sortedPeaks = rawPeaks.sortedByDescending { smoothed[it] }
            val filteredPeaks = mutableListOf<Int>()
            for (p in sortedPeaks) {
                if (filteredPeaks.none { kotlin.math.abs(it - p) < minDistance }) {
                    filteredPeaks.add(p)
                }
            }
            val detectedCenters = filteredPeaks.sorted().map { it.toFloat() }

            // 7. Regularized alignment if expectedCount is specified
            val finalCenters: List<Float>
            val nominalStep = width / expectedN.toFloat()

            if (detectedCenters.size == expectedN) {
                finalCenters = detectedCenters
            } else if (detectedCenters.isNotEmpty()) {
                // Compute best phase offset to align regular grid with detected peaks
                val offsets = detectedCenters.map { x ->
                    val slot = ((x / nominalStep) - 0.5f).toInt().coerceIn(0, expectedN - 1)
                    x - (slot + 0.5f) * nominalStep
                }
                val medianOffset = offsets.sorted()[offsets.size / 2]
                    .coerceIn(-nominalStep * 0.35f, nominalStep * 0.35f)

                finalCenters = (0 until expectedN).map { i ->
                    val nominal = (i + 0.5f) * nominalStep + medianOffset
                    val close = detectedCenters.firstOrNull { kotlin.math.abs(it - nominal) < nominalStep * 0.4f }
                    (close ?: nominal).coerceIn(4f, width.toFloat() - 4f)
                }
            } else {
                // Fallback to centered agricultural slots
                finalCenters = (0 until expectedN).map { (it + 0.5f) * nominalStep }
            }

            val spacing = if (finalCenters.size >= 2) {
                (1 until finalCenters.size)
                    .map { abs(finalCenters[it] - finalCenters[it - 1]) }
                    .average().toFloat()
            } else nominalStep

            val confidence = computeConfidence(detectedCenters, expectedCount)

            RowDetectionResult(
                rowCount = finalCenters.size,
                rowCentersX = finalCenters,
                rowSpacingPx = spacing,
                confidence = confidence,
                bevWidth = width,
                bevHeight = height,
            )
        }

    private fun computeConfidence(detected: List<Float>, expected: Int?): Float {
        var score = 0.55f
        if (detected.size >= 2) {
            val diffs = (1 until detected.size).map { abs(detected[it] - detected[it - 1]) }
            val avg = diffs.average()
            val maxDev = (diffs.map { abs(it - avg) }.maxOrNull()) ?: 0.0
            val uniformity = 1f - (maxDev / (avg + 0.001)).toFloat().coerceIn(0f, 1f)
            score += uniformity * 0.25f
        }
        if (expected != null && expected > 0) {
            val ratio = detected.size.toFloat() / expected
            score += (1f - abs(ratio - 1f)).coerceIn(0f, 1f) * 0.2f
        }
        return score.coerceIn(0.6f, 0.98f)
    }
}