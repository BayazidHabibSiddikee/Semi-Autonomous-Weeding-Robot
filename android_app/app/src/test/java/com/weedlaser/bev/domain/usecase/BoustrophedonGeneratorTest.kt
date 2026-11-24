package com.weedlaser.bev.domain.usecase

import com.weedlaser.bev.domain.model.Field
import com.weedlaser.bev.domain.model.FieldCorners
import com.weedlaser.bev.domain.model.FieldPoint
import com.weedlaser.bev.domain.model.HomographyCalibration
import com.weedlaser.bev.domain.model.ImagePoint
import com.weedlaser.bev.domain.model.PathSegment
import com.weedlaser.bev.domain.model.RowDetectionResult
import com.weedlaser.bev.domain.model.TurnDirection
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Test

class BoustrophedonGeneratorTest {

    private val generator = BoustrophedonGenerator()

    @Test
    fun testBoustrophedonPathGenerationAlternatingTurns() {
        val field = Field(
            widthM = 6.0,
            lengthM = 8.0,
            totalRows = 4,
            rowSpacingM = 1.5,
        )

        val calibration = HomographyCalibration(
            sourceCorners = FieldCorners(
                topLeft = ImagePoint(0f, 0f),
                topRight = ImagePoint(800f, 0f),
                bottomRight = ImagePoint(800f, 600f),
                bottomLeft = ImagePoint(0f, 600f),
            ),
            destWidth = 800,
            destHeight = 600,
            matrix = List(9) { 0f },
            fieldWidthM = 6.0,
            fieldLengthM = 8.0,
        )

        val rowDetection = RowDetectionResult(
            rowCount = 4,
            rowCentersX = listOf(100f, 300f, 500f, 700f),
            rowSpacingPx = 200f,
            confidence = 0.95f,
            bevWidth = 800,
            bevHeight = 600,
        )

        val mission = generator.generate(field, rowDetection, calibration)

        assertNotNull(mission)
        assertEquals(4, mission.totalRows)

        val followRows = mission.rowSegments
        val turns = mission.turnSegments

        assertEquals(4, followRows.size)
        assertEquals(3, turns.size)

        // Verify serpentine alternating turn directions
        assertEquals(TurnDirection.RIGHT, turns[0].direction)
        assertEquals(TurnDirection.LEFT, turns[1].direction)
        assertEquals(TurnDirection.RIGHT, turns[2].direction)

        // Verify total distance is greater than 4 rows of 8m each
        assertTrue(mission.totalDistanceM >= 32.0)
    }

    @Test
    fun testHomographyCalibrationCoordinateConversion() {
        val calibration = HomographyCalibration(
            sourceCorners = FieldCorners(
                topLeft = ImagePoint(0f, 0f),
                topRight = ImagePoint(800f, 0f),
                bottomRight = ImagePoint(800f, 600f),
                bottomLeft = ImagePoint(0f, 600f),
            ),
            destWidth = 800,
            destHeight = 600,
            matrix = List(9) { 0f },
            fieldWidthM = 6.0,
            fieldLengthM = 8.0,
        )

        // Center pixel in BEV
        val fieldPoint = calibration.pixelToField(400f, 300f)
        assertEquals(4.0, fieldPoint.x, 0.01) // length
        assertEquals(3.0, fieldPoint.y, 0.01) // width

        val roundTripPx = calibration.fieldToPixel(fieldPoint)
        assertEquals(400f, roundTripPx.x, 0.01f)
        assertEquals(300f, roundTripPx.y, 0.01f)
    }

    @Test
    fun testFieldCornersValidationPureJvm() {
        val valid = FieldCorners(
            topLeft = ImagePoint(100f, 100f),
            topRight = ImagePoint(700f, 120f),
            bottomRight = ImagePoint(750f, 550f),
            bottomLeft = ImagePoint(80f, 540f),
        )
        assertTrue(valid.isValid())

        // Self-intersecting bow-tie quadrilateral must be rejected
        val bowtie = FieldCorners(
            topLeft = ImagePoint(100f, 100f),
            topRight = ImagePoint(700f, 550f),
            bottomRight = ImagePoint(700f, 100f),
            bottomLeft = ImagePoint(100f, 550f),
        )
        assertEquals(false, bowtie.isValid())

        // Counter-clockwise order must be rejected
        val counterClockwise = FieldCorners(
            topLeft = ImagePoint(100f, 100f),
            topRight = ImagePoint(80f, 540f),
            bottomRight = ImagePoint(750f, 550f),
            bottomLeft = ImagePoint(700f, 120f),
        )
        assertEquals(false, counterClockwise.isValid())

        // Out-of-bounds corners must fail isValidForImage
        assertTrue(valid.isValidForImage(800f, 600f))
        assertEquals(false, valid.isValidForImage(600f, 500f))
    }

    @Test
    fun testDynamicAttentionWindowMatchesFieldLength() {
        val field = Field(widthM = 4.0, lengthM = 12.0, totalRows = 5, rowSpacingM = 0.8)
        val calibration = HomographyCalibration(
            sourceCorners = FieldCorners(
                ImagePoint(0f, 0f),
                ImagePoint(800f, 0f),
                ImagePoint(800f, 600f),
                ImagePoint(0f, 600f),
            ),
            destWidth = 800,
            destHeight = 600,
            matrix = List(9) { 0f },
            fieldWidthM = 4.0,
            fieldLengthM = 12.0,
        )
        val rows = RowDetectionResult(5, listOf(80f, 240f, 400f, 560f, 720f), 160f, 0.9f, 800, 600)
        val mission = generator.generate(field, rows, calibration)
        assertEquals(11.0, mission.attentionWindow.startM, 0.001)
        assertEquals(12.5, mission.attentionWindow.endM, 0.001)
    }
}
