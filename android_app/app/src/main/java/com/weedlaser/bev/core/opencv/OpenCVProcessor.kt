package com.weedlaser.bev.core.opencv

import org.opencv.android.OpenCVLoader
import org.opencv.core.Mat
import org.opencv.core.MatOfPoint2f
import org.opencv.core.Point
import org.opencv.core.Scalar
import org.opencv.core.Size
import org.opencv.imgcodecs.Imgcodecs
import org.opencv.imgproc.Imgproc
import java.io.File

/**
 * Wrapper for all OpenCV operations used in the BEV pipeline.
 * Loads the native OpenCV library once and exposes high-level
 * image-processing functions.
 */
class OpenCVProcessor {

    @Volatile
    private var initialized = false

    /**
     * Load the native OpenCV library. Must be called before any other method.
     */
    fun init(): Boolean {
        if (initialized) return true
        try {
            System.loadLibrary("c++_shared")
        } catch (e: Throwable) {
            android.util.Log.w("OpenCVProcessor", "Could not pre-load c++_shared: ${e.message}")
        }
        val loaded = try {
            if (OpenCVLoader.initLocal()) {
                true
            } else if (OpenCVLoader.initDebug()) {
                true
            } else {
                System.loadLibrary("opencv_java4")
                true
            }
        } catch (e: Throwable) {
            android.util.Log.e("OpenCVProcessor", "OpenCVLoader failed, trying System.loadLibrary: ${e.message}")
            try {
                System.loadLibrary("opencv_java4")
                true
            } catch (err: Throwable) {
                android.util.Log.e("OpenCVProcessor", "Direct System.loadLibrary failed: ${err.message}", err)
                false
            }
        }
        initialized = loaded
        return loaded
    }

    fun isNativeAvailable(): Boolean = initialized

    /**
     * Warp a source image into a top-down Bird's Eye View using a
     * 4-point perspective (homography) transform.
     * Uses OpenCV when native libs are available, otherwise falls back to
     * pure-Kotlin Android Bitmap perspective warping.
     *
     * @param inputPath Path to the source (angled) photo
     * @param outputPath Path to save the BEV image
     * @param srcCorners 4 source points in image pixels, clockwise from top-left
     * @param outputW Desired BEV width in pixels
     * @param outputH Desired BEV height in pixels
     * @return The 3x3 homography matrix as 9 row-major floats
     */
    fun warpToBEV(
        inputPath: String,
        outputPath: String,
        srcCorners: List<Point>,
        outputW: Int,
        outputH: Int,
    ): Result<FloatArray> = runCatching {
        require(srcCorners.size == 4) { "Need exactly 4 corner points" }

        if (!initialized) {
            init()
        }

        if (initialized) {
            warpWithOpenCV(inputPath, outputPath, srcCorners, outputW, outputH)
        } else {
            android.util.Log.w(TAG, "OpenCV native unavailable — using pure-Kotlin Bitmap homography fallback")
            warpWithBitmapFallback(inputPath, outputPath, srcCorners, outputW, outputH)
        }
    }

    private fun warpWithOpenCV(
        inputPath: String,
        outputPath: String,
        srcCorners: List<Point>,
        outputW: Int,
        outputH: Int,
    ): FloatArray {
        val src = Imgcodecs.imread(inputPath, Imgcodecs.IMREAD_COLOR)
            ?: error("Failed to read source image: $inputPath")
        require(!src.empty()) { "Empty source image" }

        val srcPts = MatOfPoint2f(*srcCorners.toTypedArray())
        val dstPts = MatOfPoint2f(
            Point(0.0, 0.0),
            Point(outputW.toDouble(), 0.0),
            Point(outputW.toDouble(), outputH.toDouble()),
            Point(0.0, outputH.toDouble()),
        )

        val homography = Imgproc.getPerspectiveTransform(srcPts, dstPts)
        require(homography.rows() == 3 && homography.cols() == 3) { "Degenerate homography" }

        val bev = Mat()
        Imgproc.warpPerspective(
            src,
            bev,
            homography,
            Size(outputW.toDouble(), outputH.toDouble()),
            Imgproc.INTER_LINEAR,
            org.opencv.core.Core.BORDER_CONSTANT,
            Scalar(0.0),
        )

        val outDir = File(outputPath).parentFile
        if (outDir != null) outDir.mkdirs()
        require(Imgcodecs.imwrite(outputPath, bev)) { "Failed to write BEV" }

        val flat = FloatArray(9)
        for (i in 0 until 3) for (j in 0 until 3) {
            flat[i * 3 + j] = homography.get(i, j)[0].toFloat()
        }

        src.release()
        srcPts.release()
        dstPts.release()
        bev.release()
        homography.release()

        return flat
    }

    private fun warpWithBitmapFallback(
        inputPath: String,
        outputPath: String,
        srcCorners: List<Point>,
        outputW: Int,
        outputH: Int,
    ): FloatArray {
        val srcBitmap = android.graphics.BitmapFactory.decodeFile(inputPath)
            ?: error("Failed to decode source image: $inputPath")
        val srcW = srcBitmap.width
        val srcH = srcBitmap.height
        val srcPixels = IntArray(srcW * srcH)
        srcBitmap.getPixels(srcPixels, 0, srcW, 0, 0, srcW, srcH)
        srcBitmap.recycle()

        val dstCorners = listOf(
            Point(0.0, 0.0),
            Point(outputW.toDouble(), 0.0),
            Point(outputW.toDouble(), outputH.toDouble()),
            Point(0.0, outputH.toDouble()),
        )
        val forwardH = computeHomography8(srcCorners, dstCorners)
        val invH = computeHomography8(dstCorners, srcCorners)

        val dstPixels = IntArray(outputW * outputH)
        val h0 = invH[0]; val h1 = invH[1]; val h2 = invH[2]
        val h3 = invH[3]; val h4 = invH[4]; val h5 = invH[5]
        val h6 = invH[6]; val h7 = invH[7]; val h8 = invH[8]

        for (y in 0 until outputH) {
            for (x in 0 until outputW) {
                val w = h6 * x + h7 * y + h8
                if (kotlin.math.abs(w) < 1e-8) continue
                val sx = (h0 * x + h1 * y + h2) / w
                val sy = (h3 * x + h4 * y + h5) / w
                if (sx < 0.0 || sy < 0.0 || sx >= srcW - 1 || sy >= srcH - 1) {
                    dstPixels[y * outputW + x] = android.graphics.Color.BLACK
                    continue
                }
                val x0 = sx.toInt()
                val y0 = sy.toInt()
                val fx = (sx - x0).toFloat()
                val fy = (sy - y0).toFloat()
                val p00 = srcPixels[y0 * srcW + x0]
                val p10 = srcPixels[y0 * srcW + x0 + 1]
                val p01 = srcPixels[(y0 + 1) * srcW + x0]
                val p11 = srcPixels[(y0 + 1) * srcW + x0 + 1]

                val w00 = (1f - fx) * (1f - fy)
                val w10 = fx * (1f - fy)
                val w01 = (1f - fx) * fy
                val w11 = fx * fy

                val r = (((p00 shr 16) and 0xFF) * w00 + ((p10 shr 16) and 0xFF) * w10 +
                    ((p01 shr 16) and 0xFF) * w01 + ((p11 shr 16) and 0xFF) * w11).toInt().coerceIn(0, 255)
                val g = (((p00 shr 8) and 0xFF) * w00 + ((p10 shr 8) and 0xFF) * w10 +
                    ((p01 shr 8) and 0xFF) * w01 + ((p11 shr 8) and 0xFF) * w11).toInt().coerceIn(0, 255)
                val b = ((p00 and 0xFF) * w00 + (p10 and 0xFF) * w10 +
                    (p01 and 0xFF) * w01 + (p11 and 0xFF) * w11).toInt().coerceIn(0, 255)
                dstPixels[y * outputW + x] = (0xFF shl 24) or (r shl 16) or (g shl 8) or b
            }
        }

        val outBitmap = android.graphics.Bitmap.createBitmap(outputW, outputH, android.graphics.Bitmap.Config.ARGB_8888)
        outBitmap.setPixels(dstPixels, 0, outputW, 0, 0, outputW, outputH)
        val outFile = File(outputPath)
        outFile.parentFile?.mkdirs()
        java.io.FileOutputStream(outFile).use { out ->
            require(outBitmap.compress(android.graphics.Bitmap.CompressFormat.JPEG, 92, out)) {
                "Failed to write BEV fallback JPEG"
            }
        }
        outBitmap.recycle()

        return FloatArray(9) { i -> forwardH[i].toFloat() }
    }

    private fun computeHomography8(src: List<Point>, dst: List<Point>): DoubleArray {
        val m = Array(8) { DoubleArray(9) }
        for (i in 0 until 4) {
            val x = src[i].x; val y = src[i].y
            val u = dst[i].x; val v = dst[i].y
            m[2 * i] = doubleArrayOf(x, y, 1.0, 0.0, 0.0, 0.0, -u * x, -u * y, u)
            m[2 * i + 1] = doubleArrayOf(0.0, 0.0, 0.0, x, y, 1.0, -v * x, -v * y, v)
        }
        for (col in 0 until 8) {
            var maxRow = col
            var maxVal = kotlin.math.abs(m[col][col])
            for (r in col + 1 until 8) {
                val v = kotlin.math.abs(m[r][col])
                if (v > maxVal) {
                    maxVal = v
                    maxRow = r
                }
            }
            require(maxVal > 1e-12) { "Degenerate homography: corners may be collinear" }
            if (maxRow != col) {
                val tmp = m[col]; m[col] = m[maxRow]; m[maxRow] = tmp
            }
            val pivot = m[col][col]
            for (j in col..8) m[col][j] /= pivot
            for (r in 0 until 8) {
                if (r == col) continue
                val factor = m[r][col]
                for (j in col..8) m[r][j] -= factor * m[col][j]
            }
        }
        return DoubleArray(9) { i -> if (i < 8) m[i][8] else 1.0 }
    }

    fun dispose() { /* OpenCVLoader manages lifecycle */ }

    companion object {
        private const val TAG = "OpenCVProcessor"
    }
}
