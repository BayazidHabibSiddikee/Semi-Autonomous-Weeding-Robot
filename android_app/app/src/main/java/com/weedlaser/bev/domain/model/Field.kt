package com.weedlaser.bev.domain.model

import kotlinx.serialization.Serializable

/**
 * Represents the physical field dimensions and properties
 */
@Serializable
data class Field(
    val widthM: Double = 6.0,           // Field width in meters (shorter side)
    val lengthM: Double = 8.0,          // Field length in meters (longer side)
    val totalRows: Int = 10,            // Number of crop rows
    val rowSpacingM: Double = 0.6,      // Distance between row centers in meters
    val originCorner: OriginCorner = OriginCorner.TOP_LEFT,  // Reference corner for coordinate system
) {
    /**
     * Calculate row spacing from field width and row count
     */
    val calculatedRowSpacingM: Double
        get() = if (totalRows > 1) widthM / (totalRows - 1) else widthM

    /**
     * Field area in square meters
     */
    val areaM2: Double
        get() = widthM * lengthM

    /**
     * Total path length for boustrophedon pattern (approximate)
     */
    val estimatedPathLengthM: Double
        get() = (lengthM * totalRows) + (rowSpacingM * (totalRows - 1))
}

@Serializable
enum class OriginCorner {
    TOP_LEFT, TOP_RIGHT, BOTTOM_LEFT, BOTTOM_RIGHT
}

/**
 * Represents a single point in the field coordinate system (meters from origin)
 */
@Serializable
data class FieldPoint(
    val x: Double,  // Meters along field length (0 to lengthM)
    val y: Double,  // Meters along field width (0 to widthM)
)

/**
 * Represents a point in image pixel coordinates
 */
@Serializable
data class ImagePoint(
    val x: Float,
    val y: Float,
) {
    fun toPointF() = android.graphics.PointF(x, y)
    
    companion object {
        fun fromPointF(p: android.graphics.PointF): ImagePoint = ImagePoint(p.x, p.y)
    }
}

/**
 * Four corners of the field in image coordinates (clockwise from top-left)
 */
@Serializable
data class FieldCorners(
    val topLeft: ImagePoint,
    val topRight: ImagePoint,
    val bottomRight: ImagePoint,
    val bottomLeft: ImagePoint,
) {
    fun toList(): List<ImagePoint> = listOf(topLeft, topRight, bottomRight, bottomLeft)
    
    fun toArray(): Array<ImagePoint> = toList().toTypedArray()
    
    /**
     * Validate corners form a reasonable convex, clockwise, non-self-intersecting quadrilateral.
     * Pure Kotlin so it runs safely in both JVM unit tests and Android runtime.
     */
    fun isValid(): Boolean {
        val points = toList()
        if (points.distinct().size != 4) return false
        val signedArea = signedPolygonArea(points)
        // In image coordinates (Y downward), clockwise TL->TR->BR->BL has positive signed area
        if (signedArea <= 1000f) return false
        return isConvexClockwise(points)
    }

    /**
     * Validate corners against the actual source image dimensions:
     * all 4 corners must lie within [0..imageWidth] x [0..imageHeight],
     * be ordered clockwise without self-intersection, and cover at least 2% of the image.
     */
    fun isValidForImage(imageWidth: Float, imageHeight: Float): Boolean {
        if (imageWidth <= 0f || imageHeight <= 0f) return false
        val points = toList()
        if (points.any { it.x < 0f || it.y < 0f || it.x > imageWidth || it.y > imageHeight }) {
            return false
        }
        if (!isValid()) return false
        val minArea = (imageWidth * imageHeight) * 0.02f
        return signedPolygonArea(points) >= minArea
    }

    private fun signedPolygonArea(points: List<ImagePoint>): Float {
        var area = 0f
        for (i in points.indices) {
            val j = (i + 1) % points.size
            area += points[i].x * points[j].y
            area -= points[j].x * points[i].y
        }
        return area / 2f
    }

    private fun isConvexClockwise(points: List<ImagePoint>): Boolean {
        for (i in points.indices) {
            val a = points[i]
            val b = points[(i + 1) % points.size]
            val c = points[(i + 2) % points.size]
            val cross = (b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x)
            // Image Y points downward, so clockwise turns have positive cross product
            if (cross <= 1e-3f) return false
        }
        return true
    }
}