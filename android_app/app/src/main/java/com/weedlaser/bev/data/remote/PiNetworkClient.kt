package com.weedlaser.bev.data.remote

import com.weedlaser.bev.domain.model.ImagePoint
import com.weedlaser.bev.domain.model.MissionStatus
import com.weedlaser.bev.domain.model.PiImageResponse
import com.weedlaser.bev.domain.model.Sim3dStatus
import android.util.Base64
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import java.net.DatagramPacket
import java.net.DatagramSocket
import java.net.InetAddress
import java.net.SocketTimeoutException
import java.net.URL

/**
 * Finds the Raspberry Pi on the local network and reads its mission status.
 *
 * The phone does not need the Pi's IP address typed in: it broadcasts a short
 * UDP probe, the Pi answers with its address, and the app talks to it over
 * HTTP. Works with a phone hotspot (the Pi joins the hotspot and gets a
 * 192.168.43.x address) as well as plain Wi-Fi.
 */
class PiNetworkClient(
    private val json: Json = Json { ignoreUnknownKeys = true },
) {

    companion object {
        const val DISCOVERY_PORT = 9999
        const val PROBE = "WEEDLASER_DISCOVER"
        const val DEFAULT_MISSION_PORT = 8080
    }

    data class PiInfo(
        val name: String,
        val host: String,
        val port: Int,
    ) {
        val baseUrl: String get() = "http://$host:$port"
    }

    /**
     * Broadcast a discovery probe and wait for the Pi to answer.
     *
     * @param timeoutMs how long to wait for replies
     * @return the Pi's address, or null when nothing answered
     */
    suspend fun discover(timeoutMs: Int = 3000): PiInfo? =
        discoverUdp(timeoutMs) ?: discoverHttp(timeoutMs)

    private suspend fun discoverUdp(timeoutMs: Int): PiInfo? = withContext(Dispatchers.IO) {
        DatagramSocket().use { socket ->
            socket.broadcast = true
            socket.soTimeout = timeoutMs
            val probe = PROBE.toByteArray()
            val targets = listOf(
                InetAddress.getByName("255.255.255.255"),
                InetAddress.getByName("192.168.43.255"),
                InetAddress.getByName("192.168.0.255"),
            )
            targets.forEach { addr ->
                runCatching { socket.send(DatagramPacket(probe, probe.size, addr, DISCOVERY_PORT)) }
            }

            val buffer = ByteArray(2048)
            val deadline = System.currentTimeMillis() + timeoutMs
            while (System.currentTimeMillis() < deadline) {
                try {
                    val packet = DatagramPacket(buffer, buffer.size)
                    socket.receive(packet)
                    val text = String(packet.data, 0, packet.length)
                    val info = parseInfo(text) ?: continue
                    return@withContext info
                } catch (e: SocketTimeoutException) {
                    break
                } catch (e: Exception) {
                    continue
                }
            }
            null
        }
    }

    /**
     * Fallback for routers that drop UDP broadcasts (very common): ask every
     * address in the phone's own subnet for GET /health on port 8080.
     */
    private suspend fun discoverHttp(timeoutMs: Int = 9000): PiInfo? = withContext(Dispatchers.IO) {
        val prefix = localSubnetPrefix() ?: return@withContext null
        val probeTimeout = (timeoutMs / 4).coerceIn(300, 1500)
        val hosts = (1..254).map { "$prefix.$it" }
        runCatching {
            coroutineScope {
                hosts.map { host ->
                    async(Dispatchers.IO) { probeHttp(host, probeTimeout) }
                }.awaitAll().firstNotNullOfOrNull { it }
            }
        }.getOrNull()
    }

    /** One subnet address: is there a mission server on port 8080? */
    private fun probeHttp(host: String, timeoutMs: Int): PiInfo? = runCatching {
        java.net.Socket().use { socket ->
            socket.connect(
                java.net.InetSocketAddress(host, DEFAULT_MISSION_PORT),
                timeoutMs,
            )
        }
        val connection = (URL("http://$host:$DEFAULT_MISSION_PORT/health")
            .openConnection() as java.net.HttpURLConnection)
        connection.connectTimeout = timeoutMs
        connection.readTimeout = timeoutMs
        val body = connection.inputStream.use { stream -> stream.readBytes().decodeToString() }
        connection.disconnect()
        if (!"weedlaser".toRegex(RegexOption.IGNORE_CASE).containsMatchIn(body) &&
            !"mission".toRegex(RegexOption.IGNORE_CASE).containsMatchIn(body)
        ) {
            return null
        }
        val name = runCatching {
            (json.parseToJsonElement(body)
                as kotlinx.serialization.json.JsonObject)["name"]
                ?.toString()?.removeSurrounding("\"")
        }.getOrNull() ?: "Rover Pi"
        PiInfo(name = name, host = host, port = DEFAULT_MISSION_PORT)
    }.getOrNull()

    /** The phone's own IPv4 subnet prefix, e.g. "192.168.0". */
    private fun localSubnetPrefix(): String? = runCatching {
        val interfaces = java.util.Collections.list(java.net.NetworkInterface.getNetworkInterfaces())
        val local = interfaces.asSequence()
            .flatMap { nif -> java.util.Collections.list(nif.inetAddresses).asSequence() }
            .filter { !it.isLoopbackAddress && it.isSiteLocalAddress && !it.isMulticastAddress }
            .map { it.hostAddress ?: "" }
            .first { it.contains('.') && !it.contains(':') }
        local.substringBeforeLast('.')
    }.getOrNull()

    private fun parseInfo(payload: String): PiInfo? = runCatching {
        val obj = json.parseToJsonElement(payload).let { it as kotlinx.serialization.json.JsonObject }
        if (obj["service"]?.toString()?.contains("weedlaser") != true) return null
        PiInfo(
            name = obj["name"]?.toString()?.trim('"') ?: "rover-pi",
            host = obj["host"]?.toString()?.trim('"') ?: return null,
            port = obj["port"]?.toString()?.trim('"')?.toIntOrNull() ?: DEFAULT_MISSION_PORT,
        )
    }.getOrNull()

    /**
     * Read the current mission status from the Pi (`GET /status`).
     */
    suspend fun fetchStatus(baseUrl: String): Result<MissionStatus> = withContext(Dispatchers.IO) {
        runCatching {
            val connection = (URL("$baseUrl/status").openConnection() as java.net.HttpURLConnection)
            connection.connectTimeout = 5000
            connection.readTimeout = 5000
            connection.requestMethod = "GET"
            val body = connection.inputStream.bufferedReader().use { it.readText() }
            connection.disconnect()
            json.decodeFromString(MissionStatus.serializer(), body)
        }
    }

    /**
     * Upload the field photo + the 4 selected corners to the Pi.
     *
     * The Pi does the heavy work (BEV warp, vegetation segmentation, row
     * detection, mission generation) and answers with the plan it computed.
     *
     * @param baseUrl Pi base URL, e.g. `http://192.168.43.57:8080`
     * @param imageBytes the raw JPEG/PNG bytes
     * @param corners the 4 corner points in *original photo* pixel coordinates
     */
    suspend fun uploadPhoto(
        baseUrl: String,
        imageBytes: ByteArray,
        corners: List<ImagePoint>,
        fieldWidthM: Double,
        fieldLengthM: Double,
        expectedRows: Int = 0,
        speedMps: Double = 0.5,
        laserRangeM: Double = 0.30,
        weedThreshold: Double = 50.0,
        headlandMarginM: Double = 0.2,
        maxWeeds: Double = 60.0,
        renderer: String = "freecad",
    ): Result<PiImageResponse> = withContext(Dispatchers.IO) {
        runCatching {
            require(corners.size == 4) { "exactly 4 corner points are required" }

            val payload = buildJsonObject {
                put("image", Base64.encodeToString(imageBytes, Base64.NO_WRAP))
                put("corners", buildJsonArray {
                    corners.forEach { c ->
                        add(buildJsonObject {
                            put("x", c.x.toDouble())
                            put("y", c.y.toDouble())
                        })
                    }
                })
                put("field", buildJsonObject {
                    put("widthM", fieldWidthM)
                    put("lengthM", fieldLengthM)
                    put("totalRows", expectedRows)
                    put("speedMps", speedMps)
                    put("laserRangeM", laserRangeM)
                    put("weedThreshold", weedThreshold)
                    put("headlandMarginM", headlandMarginM)
                    put("maxWeeds", maxWeeds)
                    put("renderer", renderer)
                })
            }

            val connection = (URL("$baseUrl/image").openConnection() as java.net.HttpURLConnection)
            connection.requestMethod = "POST"
            connection.connectTimeout = 15000
            connection.readTimeout = 120000
            connection.doOutput = true
            connection.setRequestProperty("Content-Type", "application/json")
            connection.outputStream.use { it.write(payload.toString().toByteArray()) }

            val code = connection.responseCode
            val stream = if (code in 200..299) connection.inputStream else connection.errorStream
            val body = stream?.bufferedReader()?.use { it.readText() } ?: ""
            connection.disconnect()

            if (code !in 200..299) {
                // surface the Pi's real rejection message (e.g. "no crop rows
                // detected") instead of a generic FileNotFound IOException
                val detail = try {
                    json.decodeFromString(PiImageResponse.serializer(), body).error
                } catch (_: Exception) {
                    null
                }
                throw IllegalStateException(detail ?: "HTTP $code from the Pi")
            }

            json.decodeFromString(PiImageResponse.serializer(), body)
        }
    }

    /**
     * Download an image artifact (BEV / plan overlay) the Pi produced.
     */
    suspend fun fetchArtifact(baseUrl: String, url: String): Result<ByteArray> =
        withContext(Dispatchers.IO) {
            runCatching {
                val full = if (url.startsWith("http")) url else "$baseUrl$url"
                val connection = (URL(full).openConnection() as java.net.HttpURLConnection)
                connection.connectTimeout = 10000
                connection.readTimeout = 30000
                val bytes = connection.inputStream.use { it.readBytes() }
                connection.disconnect()
                bytes
            }
        }

    /**
     * Poll the Pi's 3D digital-twin render job (started automatically after
     * every photo upload). `GET /sim3d` returns the render state and, once
     * finished, the path of the finished weeding video.
     */
    suspend fun fetchSimStatus(baseUrl: String): Result<Sim3dStatus> =
        withContext(Dispatchers.IO) {
            runCatching {
                val connection = (URL("$baseUrl/sim3d").openConnection() as java.net.HttpURLConnection)
                connection.connectTimeout = 8000
                connection.readTimeout = 15000
                val body = connection.inputStream.bufferedReader().use { it.readText() }
                connection.disconnect()
                json.decodeFromString(Sim3dStatus.serializer(), body)
            }
        }
}
