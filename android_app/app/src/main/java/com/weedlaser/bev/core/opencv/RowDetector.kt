package com.weedlaser.bev.core.opencv

import org.opencv.core.Core
import org.opencv.core.Mat
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
    fun detect(
        bevPath: String,
        expectedCount: Int? = null,
        useNativeOpenCV: Boolean = true,
    ): Result<RowDetectionResult> =
        runCatching {
            val (width, height, colGreen) = if (useNativeOpenCV) {
                try {
                    extractColumnProfileOpenCV(bevPath)
                } catch (e: UnsatisfiedLinkError) {
                    android.util.Log.w("RowDetector", "OpenCV JNI unavailable, using Bitmap fallback: ${e.message}")
                    extractColumnProfileBitmap(bevPath)
                }
            } else {
                extractColumnProfileBitmap(bevPath)
            }

            // 5. 1D weighted smoothing
            val expectedN = (expectedCount ?: 10).coerceAtLeast(1)
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
            val peakThreshold = maxOf(meanGreen * 0.45f, 0.03f)
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

            // 7. Only align to expected grid when genuine crop-row evidence exists (>= 50% of expected and >= 2 peaks)
            val nominalStep = width / expectedN.toFloat()
            val minRequiredForAlignment = maxOf(2, (expectedN + 1) / 2)

            val finalCenters: List<Float> = when {
                meanGreen < 0.01f || detectedCenters.isEmpty() -> emptyList()
                detectedCenters.size == expectedN -> detectedCenters
                detectedCenters.size >= minRequiredForAlignment -> {
                    val offsets = detectedCenters.map { x ->
                        val slot = ((x / nominalStep) - 0.5f).toInt().coerceIn(0, expectedN - 1)
                        x - (slot + 0.5f) * nominalStep
                    }
                    val medianOffset = offsets.sorted()[offsets.size / 2]
                        .coerceIn(-nominalStep * 0.35f, nominalStep * 0.35f)

                    (0 until expectedN).map { i ->
                        val nominal = (i + 0.5f) * nominalStep + medianOffset
                        val close = detectedCenters.firstOrNull { kotlin.math.abs(it - nominal) < nominalStep * 0.4f }
                        (close ?: nominal).coerceIn(4f, width.toFloat() - 4f)
                    }
                }
                else -> detectedCenters // Do NOT fabricate rows when detection evidence is weak
            }

            val spacing = if (finalCenters.size >= 2) {
                (1 until finalCenters.size)
                    .map { abs(finalCenters[it] - finalCenters[it - 1]) }
                    .average().toFloat()
            } else 0f

            val confidence = computeConfidence(detectedCenters, expectedN, meanGreen)

            RowDetectionResult(
                rowCount = finalCenters.size,
                rowCentersX = finalCenters,
                rowSpacingPx = spacing,
                confidence = confidence,
                bevWidth = width,
                bevHeight = height,
                detectedRowCount = detectedCenters.size,
            )
        }

    private fun computeConfidence(detected: List<Float>, expected: Int, meanGreen: Float): Float {
        if (detected.isEmpty() || meanGreen < 0.01f) return 0.0f

        val detectionRatio = (detected.size.toFloat() / expected.coerceAtLeast(1)).coerceIn(0f, 1f)
        val uniformity = if (detected.size >= 2) {
            val diffs = (1 until detected.size).map { abs(detected[it] - detected[it - 1]) }
            val avg = diffs.average()
            val maxDev = (diffs.map { abs(it - avg) }.maxOrNull()) ?: 0.0
            1f - (maxDev / (avg + 0.001)).toFloat().coerceIn(0f, 1f)
        } else {
            0.35f
        }
        val vegSignal = (meanGreen / 0.12f).coerceIn(0f, 1f)

        val score = 0.50f * detectionRatio + 0.30f * uniformity + 0.20f * vegSignal
        return score.coerceIn(0.0f, 0.98f)
    }

    private fun extractColumnProfileOpenCV(bevPath: String): Triple<Int, Int, FloatArray> {
        val mat = Imgcodecs.imread(bevPath, Imgcodecs.IMREAD_COLOR)
        require(!mat.empty()) { "Failed to read BEV: $bevPath" }

        val width = mat.cols()
        val height = mat.rows()

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

        val exgMask = Mat()
        Core.compare(exg, Scalar(0.0), exgMask, Core.CMP_GT)

        val hsv = Mat()
        Imgproc.cvtColor(mat, hsv, Imgproc.COLOR_BGR2HSV)
        val hsvMask = Mat()
        Core.inRange(hsv, Scalar(20.0, 25.0, 25.0), Scalar(100.0, 255.0, 255.0), hsvMask)

        val vegMask = Mat()
        Core.bitwise_and(exgMask, hsvMask, vegMask)

        val vKernel = Imgproc.getStructuringElement(Imgproc.MORPH_RECT, Size(3.0, 15.0))
        val closed = Mat()
        Imgproc.morphologyEx(vegMask, closed, Imgproc.MORPH_CLOSE, vKernel)

        b.release(); g.release(); r.release()
        g16.release(); r16.release(); b16.release()
        twoG.release(); rPlusB.release(); exg.release()
        exgMask.release(); hsv.release(); hsvMask.release()
        vegMask.release(); vKernel.release()

        // Single JNI bulk copy instead of width*height individual JNI calls
        val buf = ByteArray(width * height)
        closed.get(0, 0, buf)
        closed.release()
        mat.release()

        val colCounts = IntArray(width)
        for (row in 0 until height) {
            val rowOffset = row * width
            for (c in 0 until width) {
                if (buf[rowOffset + c].toInt() != 0) colCounts[c]++
            }
        }
        val colGreen = FloatArray(width) { c -> colCounts[c] / height.toFloat() }
        return Triple(width, height, colGreen)
    }

    private fun extractColumnProfileBitmap(bevPath: String): Triple<Int, Int, FloatArray> {
        val bitmap = android.graphics.BitmapFactory.decodeFile(bevPath)
            ?: error("Failed to decode BEV image: $bevPath")
        val width = bitmap.width
        val height = bitmap.height
        val pixels = IntArray(width * height)
        bitmap.getPixels(pixels, 0, width, 0, 0, width, height)
        bitmap.recycle()

        val mask = ByteArray(width * height)
        val hsv = FloatArray(3)
        for (i in pixels.indices) {
            val px = pixels[i]
            val r = (px shr 16) and 0xFF
            val g = (px shr 8) and 0xFF
            val b = px and 0xFF
            if (2 * g - r - b <= 0) continue

            android.graphics.Color.RGBToHSV(r, g, b, hsv)
            val hOpenCv = hsv[0] / 2f
            val s255 = hsv[1] * 255f
            val v255 = hsv[2] * 255f
            if (hOpenCv in 20f..100f && s255 >= 25f && v255 >= 25f) {
                mask[i] = 1
            }
        }

        val colCounts = IntArray(width)
        for (row in 0 until height) {
            val rowOffset = row * width
            for (c in 0 until width) {
                if (mask[rowOffset + c].toInt() != 0) colCounts[c]++
            }
        }
        val colGreen = FloatArray(width) { c -> colCounts[c] / height.toFloat() }
        return Triple(width, height, colGreen)
    }
}