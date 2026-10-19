package com.weedlaser.bev.domain.model

import kotlinx.serialization.Serializable

/**
 * Mission path segment types
 */
@Serializable
sealed interface PathSegment {
    @Serializable
    data class FollowRow(
        val seq: Int,
        val row: Int,
        val expectedDistM: Double,
        val turnAfter: TurnDirection,
        val startPoint: FieldPoint,
        val endPoint: FieldPoint,
    ) : PathSegment

    @Serializable
    data class Turn(
        val seq: Int,
        val direction: TurnDirection,
        val gapM: Double,
        val startPoint: FieldPoint,
        val endPoint: FieldPoint,
    ) : PathSegment
}

@Serializable
enum class TurnDirection {
    LEFT, RIGHT
}

/**
 * Complete mission payload sent to Raspberry Pi
 */
@Serializable
data class Mission(
    val version: Int = 1,
    val field: Field,
    val path: List<PathSegment>,
    val attentionWindow: AttentionWindow = AttentionWindow(
        startM = 7.0,
        endM = 8.5
    ),
    val generatedAt: Long = System.currentTimeMillis(),
) {
    /**
     * Total number of rows to traverse
     */
    val totalRows: Int = field.totalRows
    
    /**
     * Total estimated distance in meters
     */
    val totalDistanceM: Double
        get() = path.sumOf { 
            when (it) {
                is PathSegment.FollowRow -> it.expectedDistM
                is PathSegment.Turn -> it.gapM
            }
        }
    
    /**
     * Get all follow-row segments in order
     */
    val rowSegments: List<PathSegment.FollowRow>
        get() = path.filterIsInstance<PathSegment.FollowRow>()
    
    /**
     * Get all turn segments in order
     */
    val turnSegments: List<PathSegment.Turn>
        get() = path.filterIsInstance<PathSegment.Turn>()
}

/**
 * Attention window configuration for row-end detection
 * Bot ignores row-end signals before startM, actively looks between startM and endM
 */
@Serializable
data class AttentionWindow(
    val startM: Double,   // Distance from row start to begin looking for end
    val endM: Double,     // Distance from row start to stop looking (should be > row length)
) {
    fun contains(distanceM: Double): Boolean = distanceM >= startM && distanceM <= endM
}

/**
 * Row detection result from BEV analysis
 */
@Serializable
data class RowDetectionResult(
    val rowCount: Int,
    val rowCentersX: List<Float>,  // X positions in BEV pixel coordinates
    val rowSpacingPx: Float,       // Average spacing in pixels
    val confidence: Float,         // 0.0 to 1.0
    val bevWidth: Int,
    val bevHeight: Int,
    // Corners of the detected crop field inside the BEV image (empty if not found).
    // Order: top-left, top-right, bottom-right, bottom-left.
    val fieldCorners: List<FieldPoint> = emptyList(),
    // Fraction of the BEV image covered by vegetation (0..1)
    val vegetationRatio: Float = 0f,
    // Threshold actually used on the Excess Green Index (Otsu or fallback)
    val exgThreshold: Int = 0,
)

/**
 * Live status of the running mission, polled from the Pi (`GET /status`).
 */
@Serializable
data class MissionStatus(
    val state: String = "IDLE",
    val rowsDone: Int = 0,
    val rowsTotal: Int = 0,
    val weedsFound: Int = 0,
    val weedsKilled: Int = 0,
    val weedsRemaining: Int = 0,
    val distanceM: Double = 0.0,
    val message: String = "",
    val finished: Boolean = false,
    val error: String? = null,
) {
    val progress: Float
        get() = if (rowsTotal > 0) rowsDone.toFloat() / rowsTotal else 0f
}

/**
 * Homography calibration data
 */
@Serializable
data class HomographyCalibration(
    val sourceCorners: FieldCorners,
    val destWidth: Int,
    val destHeight: Int,
    val matrix: List<Float>,  // 9 elements, row-major 3x3 matrix
    val fieldWidthM: Double,
    val fieldLengthM: Double,
) {
    /**
     * Convert BEV pixel coordinates to field meters
     */
    fun pixelToField(px: Float, py: Float): FieldPoint {
        val scaleX = fieldWidthM / destWidth
        val scaleY = fieldLengthM / destHeight
        return FieldPoint(
            x = py * scaleY,  // Note: y in image -> x in field (length)
            y = px * scaleX,  // Note: x in image -> y in field (width)
        )
    }
    
    /**
     * Convert field meters to BEV pixel coordinates
     */
    fun fieldToPixel(point: FieldPoint): ImagePoint {
        val scaleX = destWidth / fieldWidthM
        val scaleY = destHeight / fieldLengthM
        return ImagePoint(
            x = (point.y * scaleX).toFloat(),
            y = (point.x * scaleY).toFloat(),
        )
    }
}