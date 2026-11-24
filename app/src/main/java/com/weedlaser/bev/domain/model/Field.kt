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
     * Validate corners form a reasonable quadrilateral
     */
    fun isValid(): Boolean {
        val points = toList()
        // Check no duplicate points
        if (points.distinct().size != 4) return false
        // Check roughly convex (no self-intersection)
        // Simple check: area should be positive
        val area = polygonArea(points.map { it.toPointF() })
        return area > 1000 // Minimum 1000 px^2
    }
    
    private fun polygonArea(points: List<android.graphics.PointF>): Float {
        var area = 0f
        for (i in points.indices) {
            val j = (i + 1) % points.size
            area += points[i].x * points[j].y
            area -= points[j].x * points[i].y
        }
        return kotlin.math.abs(area) / 2
    }
}