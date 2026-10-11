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
        val rowLengthM = rowLengthOverrideM ?: field.lengthM

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
                val startLateral = if (index % 2 == 0) 0.0 else field.lengthM
                val startPoint = FieldPoint(startLateral, rowY)

                // End point of this row
                val endLateral = if (index % 2 == 0) field.lengthM else 0.0
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
     * If detection returned fewer rows than expected, fill in evenly spaced rows.
     */
    private fun generateEvenSpacing(
        detected: List<Double>,
        totalRows: Int,
        widthM: Double,
    ): List<Double> {
        if (detected.isEmpty()) {
            val step = widthM / totalRows
            return (0 until totalRows).map { step * (it + 0.5) }
        }
        // Use detected positions where available, fill gaps evenly
        val result = mutableListOf(detected.first())
        var last = detected.first()
        val expectedStep = if (totalRows > 1) widthM / (totalRows - 1) else widthM
        for (i in 1 until totalRows) {
            val target = i * expectedStep
            val nextDetected = detected.firstOrNull { it > last + expectedStep * 0.4 }
            result.add(if (nextDetected != null) nextDetected else target)
            last = result.last()
        }
        return result
    }
}
