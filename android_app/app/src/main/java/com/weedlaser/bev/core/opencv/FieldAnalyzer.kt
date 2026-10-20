package com.weedlaser.bev.core.opencv

import android.util.Log
import com.weedlaser.bev.domain.model.FieldPoint
import com.weedlaser.bev.domain.model.RowDetectionResult
import org.opencv.core.Core
import org.opencv.core.CvType
import org.opencv.core.Mat
import org.opencv.core.MatOfInt
import org.opencv.core.MatOfPoint
import org.opencv.core.MatOfPoint2f
import org.opencv.core.Point
import org.opencv.core.Scalar
import org.opencv.core.Size
import org.opencv.imgcodecs.Imgcodecs
import org.opencv.imgproc.Imgproc
import kotlin.math.abs
import kotlin.math.max
import kotlin.math.min
import kotlin.math.roundToInt

/**
 * Agricultural field analyzer for BEV (top-down) images.
 *
 * This is the Android port of the Python prototype in
 * `Navigation/src/field_scanner.py`, with the improvements that survived
 * testing on real aerial photos:
 *
 *  1. Excess Green Index (ExG = 2G - R - B) with an **Otsu** threshold, so the
 *     vegetation cut adapts to lighting instead of using a fixed `> 0` rule.
 *  2. HSV sanity filter combined with ExG to kill specular highlights/shadow.
 *  3. Two-stage morphology: vertical closing links leaf canopies along a row,
 *     horizontal closing links gaps across a row, opening removes speckle.
 *  4. Row extraction by **contiguous segments** of the column projection
 *     (not raw peak picking), then merging of segments closer than one row
 *     pitch - this is what fixed the double-detection of single rows.
 *  5. **Field corner detection** with `minAreaRect` over the vegetation mask,
 *     so the Pi receives the usable field rectangle.
 *  6. Optional regularized row grid (agricultural slot alignment) when the
 *     expected row count is known.
 */
class FieldAnalyzer {

    private companion object {
        const val TAG = "FieldAnalyzer"

        /** Minimum ExG value to accept as vegetation when Otsu fails. */
        const val FALLBACK_EXG_THRESHOLD = 8

        /** Rows closer than this fraction of the row pitch get merged. */
        const val MERGE_FRACTION = 0.6f
    }

    /**
     * Analyze a BEV image.
     *
     * @param bevPath path of the warped top-down image
     * @param expectedCount optional expected number of crop rows
     */
    fun analyze(bevPath: String, expectedCount: Int? = null): Result<RowDetectionResult> =
        runCatching {
            val mat = Imgcodecs.imread(bevPath, Imgcodecs.IMREAD_COLOR)
            require(!mat.empty()) { "Failed to read BEV: $bevPath" }

            val width = mat.cols()
            val height = mat.rows()

            val vegMask = vegetationMask(mat)
            val projection = columnProjection(vegMask)
            val peak = projection.maxOrNull() ?: 0f
            val threshold = if (peak > 0f) peak * 0.25f else 0f
            val rawSegments = segmentsAbove(projection, threshold)
            val merged = mergeSegments(rawSegments, width, expectedCount)
            val regularized = regularize(merged, width, expectedCount)
            val corners = detectCorners(vegMask)

            val vegetationRatio = countNonZero(vegMask) / (width.toFloat() * height.toFloat())

            val spacing = if (regularized.size >= 2) {
                (1 until regularized.size)
                    .map { abs(regularized[it] - regularized[it - 1]) }
                    .average().toFloat()
            } else {
                width / (expectedCount ?: 10).toFloat()
            }

            val confidence = computeConfidence(regularized, expectedCount, spacing, width)

            Log.i(
                TAG,
                "rows=${regularized.size} spacing=%.1fpx veg=%.1f%% corners=%d".format(
                    spacing, vegetationRatio * 100, corners.size
                )
            )

            RowDetectionResult(
                rowCount = regularized.size,
                rowCentersX = regularized,
                rowSpacingPx = spacing,
                confidence = confidence,
                bevWidth = width,
                bevHeight = height,
                fieldCorners = corners,
                vegetationRatio = vegetationRatio,
            )
        }

    /**
     * Vegetation mask: Otsu-thresholded Excess Green Index AND an HSV band.
     */
    private fun vegetationMask(mat: Mat): Mat {
        val channels = ArrayList<Mat>(3)
        Core.split(mat, channels)
        val b = channels[0]
        val g = channels[1]
        val r = channels[2]

        val g16 = Mat(); val r16 = Mat(); val b16 = Mat()
        g.convertTo(g16, CvType.CV_16SC1)
        r.convertTo(r16, CvType.CV_16SC1)
        b.convertTo(b16, CvType.CV_16SC1)

        val twoG = Mat(); val rPlusB = Mat(); val exg = Mat()
        Core.multiply(g16, Scalar(2.0), twoG)
        Core.add(r16, b16, rPlusB)
        Core.subtract(twoG, rPlusB, exg)

        // --- Otsu threshold on the ExG image
        // exg lives in [-510, 510]; scale 0.25 and shift 128 to map into 8-bit
        // without clipping, then invert the transform on the Otsu value.
        val exg8 = Mat()
        exg.convertTo(exg8, CvType.CV_8UC1, 0.25, 128.0)
        val otsuThresh = Mat()
        val thresholdValue = Imgproc.threshold(
            exg8, otsuThresh, 0.0, 255.0, Imgproc.THRESH_BINARY + Imgproc.THRESH_OTSU
        )
        val exgCut = ((thresholdValue - 128.0) * 4.0).roundToInt()
        val finalCut = if (exgCut in 1..250) exgCut else FALLBACK_EXG_THRESHOLD

        val exgMask = Mat()
        Core.compare(exg, Scalar(finalCut.toDouble()), exgMask, Core.CMP_GT)

        // --- HSV vegetation band (kills soil highlights and dark shadow)
        val hsv = Mat()
        Imgproc.cvtColor(mat, hsv, Imgproc.COLOR_BGR2HSV)
        val hsvMask = Mat()
        Core.inRange(hsv, Scalar(15.0, 20.0, 20.0), Scalar(95.0, 255.0, 255.0), hsvMask)

        val vegMask = Mat()
        Core.bitwise_and(exgMask, hsvMask, vegMask)

        // --- morphology: open (despeckle) -> vertical close (canopy) -> horizontal close (gaps)
        val openKernel = Imgproc.getStructuringElement(Imgproc.MORPH_RECT, Size(3.0, 3.0))
        val vKernel = Imgproc.getStructuringElement(Imgproc.MORPH_RECT, Size(3.0, 15.0))
        val hKernel = Imgproc.getStructuringElement(Imgproc.MORPH_RECT, Size(15.0, 3.0))

        val opened = Mat()
        Imgproc.morphologyEx(vegMask, opened, Imgproc.MORPH_OPEN, openKernel)
        val vClosed = Mat()
        Imgproc.morphologyEx(opened, vClosed, Imgproc.MORPH_CLOSE, vKernel)
        val hClosed = Mat()
        Imgproc.morphologyEx(vClosed, hClosed, Imgproc.MORPH_CLOSE, hKernel)

        b.release(); g.release(); r.release()
        g16.release(); r16.release(); b16.release()
        twoG.release(); rPlusB.release(); exg.release()
        exg8.release(); otsuThresh.release()
        exgMask.release(); hsv.release(); hsvMask.release(); vegMask.release()
        openKernel.release(); vKernel.release(); hKernel.release()
        opened.release(); vClosed.release()

        return hClosed
    }

    /** Fraction of vegetated pixels per column. */
    private fun columnProjection(mask: Mat): FloatArray {
        val width = mask.cols()
        val height = mask.rows()
        val out = FloatArray(width)
        for (c in 0 until width) {
            var count = 0
            for (r in 0 until height) {
                if (mask.get(r, c)[0].toInt() > 0) count++
            }
            out[c] = count / height.toFloat()
        }
        return out
    }

    /** Contiguous runs of columns above the threshold -> candidate rows. */
    private fun segmentsAbove(projection: FloatArray, threshold: Float): List<Int> {
        val segments = mutableListOf<Int>()
        var i = 0
        while (i < projection.size) {
            if (projection[i] > threshold) {
                var j = i
                while (j < projection.size && projection[j] > threshold) j++
                segments.add((i + j) / 2)
                i = j
            } else {
                i++
            }
        }
        return segments
    }

    /** Merge segments that are closer than one row pitch (split rows). */
    private fun mergeSegments(
        segments: List<Int>,
        width: Int,
        expectedCount: Int?,
    ): List<Float> {
        if (segments.isEmpty()) return emptyList()
        val pitch = width / (expectedCount ?: segments.size).toFloat()
        val mergeDist = max(12f, pitch * MERGE_FRACTION)
        val merged = mutableListOf<Float>()
        for (s in segments) {
            if (merged.isEmpty()) {
                merged.add(s.toFloat())
            } else if (s - merged.last() < mergeDist) {
                merged[merged.lastIndex] = (merged.last() + s) / 2f
            } else {
                merged.add(s.toFloat())
            }
        }
        return merged
    }

    /**
     * Snap rows onto a regular agricultural grid when the expected count is known.
     * Keeps the detected positions when they are close to the nominal slot.
     */
    private fun regularize(
        detected: List<Float>,
        width: Int,
        expectedCount: Int?,
    ): List<Float> {
        if (expectedCount == null || expectedCount <= 0) return detected
        if (detected.isEmpty()) {
            val step = width / expectedCount.toFloat()
            return (0 until expectedCount).map { (it + 0.5f) * step }
        }
        if (detected.size == expectedCount) return detected

        val step = width / expectedCount.toFloat()
        val offsets = detected.map { x ->
            val slot = ((x / step) - 0.5f).toInt().coerceIn(0, expectedCount - 1)
            x - (slot + 0.5f) * step
        }
        val medianOffset = offsets.sorted()[offsets.size / 2]
            .coerceIn(-step * 0.35f, step * 0.35f)

        return (0 until expectedCount).map { i ->
            val nominal = (i + 0.5f) * step + medianOffset
            val close = detected.firstOrNull { abs(it - nominal) < step * 0.4f }
            (close ?: nominal).coerceIn(4f, width - 4f)
        }
    }

    /**
     * Field corners: minimum-area rectangle around the vegetation mask.
     * Returns the four corners ordered top-left, top-right, bottom-right, bottom-left.
     */
    private fun detectCorners(vegMask: Mat): List<FieldPoint> {
        val contours = ArrayList<MatOfPoint>()
        val hierarchy = Mat()
        Imgproc.findContours(
            vegMask, contours, hierarchy, Imgproc.RETR_EXTERNAL, Imgproc.CHAIN_APPROX_SIMPLE
        )
        if (contours.isEmpty()) {
            hierarchy.release()
            return emptyList()
        }

        // every contour point in one MatOfPoint2f
        val all = MatOfPoint2f()
        val flat = ArrayList<Point>()
        for (c in contours) {
            for (p in c.toList()) flat.add(Point(p.x, p.y))
        }
        all.fromList(flat)

        // RotatedRect -> 4 corner points (boxPoints writes into a Mat)
        val rect = Imgproc.minAreaRect(all)
        all.release()
        hierarchy.release()

        val box = Mat()
        Imgproc.boxPoints(rect, box)
        val pts = ArrayList<Point>(4)
        for (i in 0 until 4) {
            pts.add(Point(box.get(i, 0)[0], box.get(i, 1)[0]))
        }
        box.release()

        val ordered = orderCorners(pts)
        return ordered.map { FieldPoint(it.x, it.y) }
    }

    /** Order 4 points as top-left, top-right, bottom-right, bottom-left. */
    private fun orderCorners(pts: List<Point>): List<Point> {
        val sorted = pts.sortedBy { it.y }
        val top = sorted.take(2).sortedBy { it.x }
        val bottom = sorted.takeLast(2).sortedBy { it.x }
        return listOf(top[0], top[1], bottom[1], bottom[0])
    }

    private fun countNonZero(mask: Mat): Float =
        Core.countNonZero(mask).toFloat()

    private fun computeConfidence(
        detected: List<Float>,
        expected: Int?,
        spacing: Float,
        width: Int,
    ): Float {
        var score = 0.5f
        if (detected.size >= 2) {
            val diffs = (1 until detected.size).map { abs(detected[it] - detected[it - 1]) }
            val avg = diffs.average()
            val maxDev = diffs.map { abs(it - avg) }.maxOrNull() ?: 0.0
            val uniformity = (1f - (maxDev / (avg + 0.001)).toFloat()).coerceIn(0f, 1f)
            score += uniformity * 0.25f
        }
        if (expected != null && expected > 0) {
            val ratio = detected.size.toFloat() / expected
            score += (1f - abs(ratio - 1f)).coerceIn(0f, 1f) * 0.2f
        }
        // a plausible row pitch means the detection is physically sensible
        if (spacing > 4f && spacing < width * 0.5f) score += 0.05f
        return score.coerceIn(0.5f, 0.98f)
    }
}
