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
        val loaded = OpenCVLoader.initLocal()
        initialized = loaded
        return loaded
    }

    /**
     * Warp a source image into a top-down Bird's Eye View using a
     * 4-point perspective (homography) transform.
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

        val src = Imgcodecs.imread(inputPath, Imgcodecs.IMREAD_COLOR)
            ?: error("Failed to read source image: $inputPath")
        require(!src.empty()) { "Empty source image" }

        val dst = src.clone()

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
            dst,
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
        dst.release()
        bev.release()
        homography.release()

        flat
    }

    fun dispose() { /* OpenCVLoader manages lifecycle */ }

    companion object {
        private const val TAG = "OpenCVProcessor"
    }
}
