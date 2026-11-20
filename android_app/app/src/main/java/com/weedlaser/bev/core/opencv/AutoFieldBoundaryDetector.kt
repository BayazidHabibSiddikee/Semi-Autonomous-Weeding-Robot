package com.weedlaser.bev.core.opencv

import android.graphics.BitmapFactory
import com.weedlaser.bev.domain.model.FieldCorners
import com.weedlaser.bev.domain.model.ImagePoint
import kotlin.math.abs
import kotlin.math.cos
import kotlin.math.hypot
import kotlin.math.sin

/**
 * Automatic Field Boundary Detector (Zero Manual Corner Selection).
 *
 * Mirrors Raspberry Pi Pipeline Step 1 & 2:
 *   1. Excess Green (ExG = 2G - R - B) + HSV vegetation mask finds crop canopy pixels.
 *   2. Computes Convex Hull + Rotating-Calipers Minimum-Area Bounding Rectangle (minAreaRect).
 *   3. Orders the 4 corners clockwise (TL, TR, BR, BL) inside image bounds for automatic BEV warp.
 */
object AutoFieldBoundaryDetector {

    data class AutoBoundaryResult(
        val corners: FieldCorners,
        val imageWidth: Int,
        val imageHeight: Int,
        val vegetationRatio: Float,
    )

    fun detectFromImageFile(imagePath: String): Result<AutoBoundaryResult> = runCatching {
        val opts = BitmapFactory.Options().apply {
            inSampleSize = 2
        }
        val sampled = BitmapFactory.decodeFile(imagePath, opts)
            ?: error("Could not decode field photo: $imagePath")

        val boundsOpts = BitmapFactory.Options().apply { inJustDecodeBounds = true }
        BitmapFactory.decodeFile(imagePath, boundsOpts)
        val fullW = boundsOpts.outWidth.coerceAtLeast(sampled.width)
        val fullH = boundsOpts.outHeight.coerceAtLeast(sampled.height)

        val sw = sampled.width
        val sh = sampled.height
        val pixels = IntArray(sw * sh)
        sampled.getPixels(pixels, 0, sw, 0, 0, sw, sh)
        sampled.recycle()

        val vegPts = ArrayList<ImagePoint>(4096)
        val hsv = FloatArray(3)
        val stride = maxOf(1, minOf(sw, sh) / 160)
        var totalSampled = 0

        for (y in 0 until sh step stride) {
            val rowOff = y * sw
            for (x in 0 until sw step stride) {
                totalSampled++
                val px = pixels[rowOff + x]
                val r = (px shr 16) and 0xFF
                val g = (px shr 8) and 0xFF
                val b = px and 0xFF
                if (2 * g - r - b <= 12) continue

                android.graphics.Color.RGBToHSV(r, g, b, hsv)
                val hOpenCv = hsv[0] / 2f
                val s255 = hsv[1] * 255f
                val v255 = hsv[2] * 255f
                if (hOpenCv in 20f..100f && s255 >= 25f && v255 >= 25f) {
                    vegPts.add(
                        ImagePoint(
                            x = (x.toFloat() / sw) * fullW,
                            y = (y.toFloat() / sh) * fullH,
                        )
                    )
                }
            }
        }

        val vegRatio = if (totalSampled > 0) vegPts.size.toFloat() / totalSampled else 0f
        val corners = if (vegPts.size >= 16) {
            minAreaBoundingQuad(vegPts, fullW.toFloat(), fullH.toFloat())
        } else {
            // Safe inset fallback when scene has low vegetation
            FieldCorners(
                topLeft = ImagePoint(fullW * 0.08f, fullH * 0.10f),
                topRight = ImagePoint(fullW * 0.92f, fullH * 0.10f),
                bottomRight = ImagePoint(fullW * 0.92f, fullH * 0.90f),
                bottomLeft = ImagePoint(fullW * 0.08f, fullH * 0.90f),
            )
        }

        AutoBoundaryResult(
            corners = corners,
            imageWidth = fullW,
            imageHeight = fullH,
            vegetationRatio = vegRatio,
        )
    }

    /**
     * Pure-Kotlin convex hull (Andrew's monotone chain) + rotating-calipers minAreaRect.
     */
    fun minAreaBoundingQuad(points: List<ImagePoint>, maxW: Float, maxH: Float): FieldCorners {
        val hull = convexHull(points)
        if (hull.size < 3) {
            return FieldCorners(
                topLeft = ImagePoint(maxW * 0.08f, maxH * 0.10f),
                topRight = ImagePoint(maxW * 0.92f, maxH * 0.10f),
                bottomRight = ImagePoint(maxW * 0.92f, maxH * 0.90f),
                bottomLeft = ImagePoint(maxW * 0.08f, maxH * 0.90f),
            )
        }

        var bestArea = Float.MAX_VALUE
        var bestBox = emptyList<ImagePoint>()

        for (i in hull.indices) {
            val p1 = hull[i]
            val p2 = hull[(i + 1) % hull.size]
            val dx = p2.x - p1.x
            val dy = p2.y - p1.y
            val len = hypot(dx, dy)
            if (len < 1e-4f) continue

            val ux = dx / len
            val uy = dy / len
            val vx = -uy
            val vy = ux

            var minU = Float.MAX_VALUE
            var maxU = -Float.MAX_VALUE
            var minV = Float.MAX_VALUE
            var maxV = -Float.MAX_VALUE

            for (p in hull) {
                val u = p.x * ux + p.y * uy
                val v = p.x * vx + p.y * vy
                if (u < minU) minU = u
                if (u > maxU) maxU = u
                if (v < minV) minV = v
                if (v > maxV) maxV = v
            }

            val area = (maxU - minU) * (maxV - minV)
            if (area < bestArea) {
                bestArea = area
                bestBox = listOf(
                    ImagePoint(minU * ux + minV * vx, minU * uy + minV * vy),
                    ImagePoint(maxU * ux + minV * vx, maxU * uy + minV * vy),
                    ImagePoint(maxU * ux + maxV * vx, maxU * uy + maxV * vy),
                    ImagePoint(minU * ux + maxV * vx, minU * uy + maxV * vy),
                )
            }
        }

        val clipped = bestBox.map { p ->
            ImagePoint(
                x = p.x.coerceIn(0f, maxW),
                y = p.y.coerceIn(0f, maxH),
            )
        }
        return orderClockwise(clipped)
    }

    private fun orderClockwise(pts: List<ImagePoint>): FieldCorners {
        val tl = pts.minBy { it.x + it.y }
        val br = pts.maxBy { it.x + it.y }
        val tr = pts.minBy { it.y - it.x }
        val bl = pts.maxBy { it.y - it.x }
        return FieldCorners(topLeft = tl, topRight = tr, bottomRight = br, bottomLeft = bl)
    }

    private fun convexHull(pts: List<ImagePoint>): List<ImagePoint> {
        val sorted = pts.sortedWith(compareBy<ImagePoint> { it.x }.thenBy { it.y })
        if (sorted.size <= 2) return sorted

        fun cross(o: ImagePoint, a: ImagePoint, b: ImagePoint): Float =
            (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x)

        val lower = ArrayList<ImagePoint>()
        for (p in sorted) {
            while (lower.size >= 2 && cross(lower[lower.size - 2], lower.last(), p) <= 0f) {
                lower.removeAt(lower.lastIndex)
            }
            lower.add(p)
        }

        val upper = ArrayList<ImagePoint>()
        for (i in sorted.indices.reversed()) {
            val p = sorted[i]
            while (upper.size >= 2 && cross(upper[upper.size - 2], upper.last(), p) <= 0f) {
                upper.removeAt(upper.lastIndex)
            }
            upper.add(p)
        }

        lower.removeAt(lower.lastIndex)
        upper.removeAt(upper.lastIndex)
        return lower + upper
    }
}
