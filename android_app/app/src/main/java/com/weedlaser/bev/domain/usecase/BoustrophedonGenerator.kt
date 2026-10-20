package com.weedlaser.bev.domain.usecase

import com.weedlaser.bev.domain.model.Field
import com.weedlaser.bev.domain.model.FieldPoint
import com.weedlaser.bev.domain.model.HomographyCalibration
import com.weedlaser.bev.domain.model.Mission
import com.weedlaser.bev.domain.model.PathSegment
import com.weedlaser.bev.domain.model.RowDetectionResult
import com.weedlaser.bev.domain.model.TurnDirection

/**
 * Generates a Boustrophedon (lawnmower) mission path for a field.
 *
 * The generator receives detected row centers (in BEV pixels) and converts
 * them to field meters using the homography calibration. It then produces
 * an ordered list of [PathSegment] entries: one [PathSegment.FollowRow] per
 * crop row and one [PathSegment.Turn] between each pair of adjacent rows.
 */
class BoustrophedonGenerator {

    /**
     * Build a [Mission] from the field, row detection result and calibration.
     *
     * @param field Field configuration (dimensions, expected row count)
     * @param rows Detected row data from BEV analysis
     * @param calibration Homography mapping pixels <-> field meters
     * @param rowLengthOverrideM Optional override for the row travel distance
     */
    fun generate(
        field: Field,
        rows: RowDetectionResult,
        calibration: HomographyCalibration,
        rowLengthOverrideM: Double? = null,
    ): Mission {
        // Headland margin keeps the rover clear of the field edges: the first
        // and last part of every row are not driven. An explicit override is
        // treated as the exact driving distance and stays as-is.
        val inset = field.headlandMarginM.coerceAtLeast(0.0)
        val rowLengthM = rowLengthOverrideM
            ?: (field.lengthM - 2.0 * inset).coerceAtLeast(0.5)
        val xEntry = inset
        val xExit = (field.lengthM - inset).coerceAtLeast(inset)

        // Convert detected row centers (BEV pixels) to field Y meters
        val rowYs = rows.rowCentersX.map { px ->
            calibration.pixelToField(px, 0f).y
        }.sorted()

        // If detection found fewer rows than expected, synthesize evenly-spaced rows
        val effectiveRowYs = if (rowYs.size >= field.totalRows) {
            rowYs.take(field.totalRows)
        } else {
            generateEvenSpacing(rowYs, field.totalRows, field.widthM)
        }

        val segments = buildList {
            var seq = 1
            var startRow: Int? = null
            var prevTurn: TurnDirection? = null

            effectiveRowYs.forEachIndexed { index, rowY ->
                val isLastRow = index == effectiveRowYs.size - 1

                // Start point of this row
                val startLateral = if (index % 2 == 0) xEntry else xExit
                val startPoint = FieldPoint(startLateral, rowY)

                // End point of this row
                val endLateral = if (index % 2 == 0) xExit else xEntry
                val endPoint = FieldPoint(endLateral, rowY)

                // Decide turn direction
                val nextTurn: TurnDirection =
                    if (index % 2 == 0) TurnDirection.RIGHT else TurnDirection.LEFT

                add(
                    PathSegment.FollowRow(
                        seq = seq++,
                        row = index + 1,
                        expectedDistM = rowLengthM,
                        turnAfter = if (isLastRow) prevTurn ?: nextTurn else nextTurn,
                        startPoint = startPoint,
                        endPoint = endPoint,
                    )
                )

                // Turn to next row if not last
                if (!isLastRow) {
                    val nextRowY = effectiveRowYs[index + 1]
                    val turnStart = FieldPoint(endLateral, rowY)
                    val turnEnd = FieldPoint(endLateral, nextRowY)
                    val gapM = kotlin.math.abs(nextRowY - rowY)
                    add(
                        PathSegment.Turn(
                            seq = seq++,
                            direction = nextTurn,
                            gapM = gapM,
                            startPoint = turnStart,
                            endPoint = turnEnd,
                        )
                    )
                }
            }
        }

        return Mission(
            field = field,
            path = segments,
        )
    }

    /**
     * If detection returned fewer rows than expected, fill in evenly spaced rows
     * with centered agricultural slots and alignment to detected crop rows.
     */
    private fun generateEvenSpacing(
        detected: List<Double>,
        totalRows: Int,
        widthM: Double,
    ): List<Double> {
        if (totalRows <= 0) return emptyList()
        val nominalStep = widthM / totalRows
        if (detected.isEmpty()) {
            return (0 until totalRows).map { (it + 0.5) * nominalStep }
        }

        // Calculate phase shift that best aligns the nominal grid with detected rows
        val offsets = detected.map { y ->
            val slot = ((y / nominalStep) - 0.5).toInt().coerceIn(0, totalRows - 1)
            y - (slot + 0.5) * nominalStep
        }
        val medianOffset = offsets.sorted()[offsets.size / 2]
            .coerceIn(-nominalStep * 0.35, nominalStep * 0.35)

        return (0 until totalRows).map { i ->
            val nominal = (i + 0.5) * nominalStep + medianOffset
            // Snap to detected row if one exists within 40% of slot width
            val close = detected.firstOrNull { kotlin.math.abs(it - nominal) < nominalStep * 0.4 }
            (close ?: nominal).coerceIn(0.05, widthM - 0.05)
        }
    }
}
