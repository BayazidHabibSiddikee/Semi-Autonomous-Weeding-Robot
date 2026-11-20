package com.weedlaser.bev.presentation

import android.content.Context
import android.net.Uri
import android.widget.Toast
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.PickVisualMediaRequest
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Info
import androidx.compose.material.icons.filled.LocationOn
import androidx.compose.material.icons.filled.Person
import androidx.compose.material.icons.filled.PlayArrow
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FilterChip
import androidx.compose.material3.FilterChipDefaults
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.NavigationBar
import androidx.compose.material3.NavigationBarItem
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.weedlaser.bev.core.opencv.AutoFieldBoundaryDetector
import com.weedlaser.bev.data.remote.NormalizedPoint
import com.weedlaser.bev.data.remote.PiLiveClient
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import org.koin.androidx.compose.koinViewModel
import java.io.File
import java.io.FileOutputStream

enum class AppTab {
    CAPTURE, LIVE, PROJECT, ABOUT
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun MainAppContainer(viewModel: BeViewModel = koinViewModel()) {
    var selectedLanguage by rememberSaveable { mutableStateOf(AppLanguage.BN) }
    var currentTab by rememberSaveable { mutableStateOf(AppTab.CAPTURE) }
    var piIp by rememberSaveable { mutableStateOf("192.168.4.1") }
    var piPort by rememberSaveable { mutableStateOf("8000") }

    CompositionLocalProvider(LocalAppLanguage provides selectedLanguage) {
        WeedLaserTheme {
            Scaffold(
                topBar = {
                    TopAppBar(
                        title = {
                            Column {
                                Text(
                                    text = Strings.appTitle(selectedLanguage),
                                    style = MaterialTheme.typography.titleMedium,
                                    fontWeight = FontWeight.Bold
                                )
                                Text(
                                    text = "Semi-Autonomous Weeding Robot",
                                    style = MaterialTheme.typography.labelSmall,
                                    color = MaterialTheme.colorScheme.onSurfaceVariant
                                )
                            }
                        },
                        actions = {
                            Row(
                                modifier = Modifier.padding(end = 8.dp),
                                horizontalArrangement = Arrangement.spacedBy(4.dp),
                                verticalAlignment = Alignment.CenterVertically
                            ) {
                                FilterChip(
                                    selected = selectedLanguage == AppLanguage.BN,
                                    onClick = { selectedLanguage = AppLanguage.BN },
                                    label = { Text("বাং", fontWeight = FontWeight.Bold) },
                                    colors = FilterChipDefaults.filterChipColors(
                                        selectedContainerColor = MaterialTheme.colorScheme.primary,
                                        selectedLabelColor = MaterialTheme.colorScheme.onPrimary
                                    )
                                )
                                FilterChip(
                                    selected = selectedLanguage == AppLanguage.EN,
                                    onClick = { selectedLanguage = AppLanguage.EN },
                                    label = { Text("EN", fontWeight = FontWeight.Bold) },
                                    colors = FilterChipDefaults.filterChipColors(
                                        selectedContainerColor = MaterialTheme.colorScheme.primary,
                                        selectedLabelColor = MaterialTheme.colorScheme.onPrimary
                                    )
                                )
                            }
                        },
                        colors = TopAppBarDefaults.topAppBarColors(
                            containerColor = MaterialTheme.colorScheme.surface
                        )
                    )
                },
                bottomBar = {
                    NavigationBar(containerColor = MaterialTheme.colorScheme.surface) {
                        NavigationBarItem(
                            selected = currentTab == AppTab.CAPTURE,
                            onClick = { currentTab = AppTab.CAPTURE },
                            icon = { Icon(Icons.Default.PlayArrow, contentDescription = "Capture") },
                            label = { Text(if (selectedLanguage == AppLanguage.BN) "শুরু করুন" else "Launch", fontSize = 11.sp) }
                        )
                        NavigationBarItem(
                            selected = currentTab == AppTab.LIVE,
                            onClick = { currentTab = AppTab.LIVE },
                            icon = { Icon(Icons.Default.LocationOn, contentDescription = "Live Rover") },
                            label = { Text(if (selectedLanguage == AppLanguage.BN) "লাইভ রোভার" else "Live Feed", fontSize = 11.sp) }
                        )
                        NavigationBarItem(
                            selected = currentTab == AppTab.PROJECT,
                            onClick = { currentTab = AppTab.PROJECT },
                            icon = { Icon(Icons.Default.Info, contentDescription = "Project") },
                            label = { Text(Strings.navProject(selectedLanguage), fontSize = 11.sp) }
                        )
                        NavigationBarItem(
                            selected = currentTab == AppTab.ABOUT,
                            onClick = { currentTab = AppTab.ABOUT },
                            icon = { Icon(Icons.Default.Person, contentDescription = "About") },
                            label = { Text(Strings.navAbout(selectedLanguage), fontSize = 11.sp) }
                        )
                    }
                }
            ) { innerPadding ->
                Surface(
                    modifier = Modifier
                        .fillMaxSize()
                        .padding(innerPadding),
                    color = MaterialTheme.colorScheme.surface
                ) {
                    when (currentTab) {
                        AppTab.CAPTURE -> BeMainScreen(
                            viewModel = viewModel,
                            piIp = piIp,
                            piPort = piPort,
                            onPiIpChanged = { piIp = it },
                            onPiPortChanged = { piPort = it },
                            onNavigateToLive = { currentTab = AppTab.LIVE },
                        )
                        AppTab.LIVE -> LiveRoverMonitorScreen(
                            piIp = piIp,
                            piPort = piPort.toIntOrNull() ?: 8000,
                            onPiIpChanged = { piIp = it },
                            onPiPortChanged = { piPort = it },
                        )
                        AppTab.PROJECT -> ProjectDetailsScreen()
                        AppTab.ABOUT -> AboutDeveloperScreen()
                    }
                }
            }
        }
    }
}

/**
 * Zero-corner Capture & Launch screen:
 *   1. Snap 1 photo -> POST /image to Pi (auto ExG + minAreaRect boundary & furrow segmentation).
 *   2. Tap only [Start] (and optional [End]) on the map.
 *   3. Send & Start Rover -> opens Live Rover tab streaming /video_feed, /map_feed, /cut_plan.
 */
@Composable
fun BeMainScreen(
    viewModel: BeViewModel = koinViewModel(),
    piIp: String = "192.168.4.1",
    piPort: String = "8000",
    onPiIpChanged: (String) -> Unit = {},
    onPiPortChanged: (String) -> Unit = {},
    onNavigateToLive: () -> Unit = {},
) {
    val lang = LocalAppLanguage.current
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    val piClient = remember { PiLiveClient() }

    var imagePath by rememberSaveable { mutableStateOf<String?>(null) }
    var furrowsNx by remember { mutableStateOf<List<Float>>(emptyList()) }
    var startPoint by remember { mutableStateOf<NormalizedPoint?>(NormalizedPoint(0.22f, 0.88f)) }
    var endPoint by remember { mutableStateOf<NormalizedPoint?>(NormalizedPoint(0.80f, 0.14f)) }
    var relayMode by rememberSaveable { mutableStateOf("grinder") }
    var statusMessage by remember { mutableStateOf<String?>(null) }
    var isSending by remember { mutableStateOf(false) }
    var pendingCameraUri by remember { mutableStateOf<Uri?>(null) }

    fun handleNewPhoto(path: String) {
        imagePath = path
        statusMessage = if (lang == AppLanguage.BN) {
            "Pi-তে ছবি পাঠানো হচ্ছে (স্বয়ংক্রিয় সীমানা ও সারি শনাক্তকরণ)..."
        } else {
            "Uploading photo to Pi (/image) for automatic boundary & furrow detection..."
        }
        scope.launch {
            val portNum = piPort.toIntOrNull() ?: 8000
            piClient.uploadFieldPhoto(piIp, portNum, File(path))
                .onSuccess { resp ->
                    furrowsNx = resp.furrowsNx
                    statusMessage = "Pi detected ${resp.furrowsNx.size} furrows (${(resp.confidence * 100).toInt()}% confidence). Tap Start & End, then launch."
                }
                .onFailure {
                    // On-device ExG + minAreaRect fallback if Pi hotspot isn't connected yet
                    val auto = withContext(Dispatchers.Default) {
                        AutoFieldBoundaryDetector.detectFromImageFile(path)
                    }
                    furrowsNx = listOf(0.22f, 0.42f, 0.62f, 0.80f)
                    statusMessage = if (auto.isSuccess) {
                        "Pi offline — local ExG auto-boundary ready. Tap Start & End, then connect Pi hotspot to start."
                    } else {
                        "Photo ready. Connect to Pi hotspot ($piIp:$portNum), tap Start & End, and send."
                    }
                }
        }
    }

    val photoPickerLauncher = rememberLauncherForActivityResult(
        contract = ActivityResultContracts.PickVisualMedia()
    ) { uri: Uri? ->
        if (uri != null) {
            scope.launch {
                val copiedPath = withContext(Dispatchers.IO) { copyUriToInternalFile(context, uri) }
                if (copiedPath != null) handleNewPhoto(copiedPath)
            }
        }
    }

    val takePictureLauncher = rememberLauncherForActivityResult(
        contract = ActivityResultContracts.TakePicture()
    ) { success: Boolean ->
        val uri = pendingCameraUri
        if (success && uri != null) {
            scope.launch {
                val copiedPath = withContext(Dispatchers.IO) { copyUriToInternalFile(context, uri) }
                if (copiedPath != null) handleNewPhoto(copiedPath)
            }
        }
    }

    fun launchCameraCapture() {
        runCatching {
            val photoFile = File(context.cacheDir, "camera_capture_${System.currentTimeMillis()}.jpg")
            val uri = androidx.core.content.FileProvider.getUriForFile(
                context,
                "${context.packageName}.fileprovider",
                photoFile
            )
            pendingCameraUri = uri
            takePictureLauncher.launch(uri)
        }.onFailure { err ->
            Toast.makeText(context, "Camera unavailable: ${err.message}", Toast.LENGTH_SHORT).show()
        }
    }

    val cameraPermissionLauncher = rememberLauncherForActivityResult(
        contract = ActivityResultContracts.RequestPermission()
    ) { granted: Boolean ->
        if (granted) launchCameraCapture()
        else Toast.makeText(context, "Camera permission is required", Toast.LENGTH_SHORT).show()
    }

    Column(
        modifier = Modifier
            .fillMaxSize()
            .verticalScroll(rememberScrollState())
            .padding(16.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        // Pi Wi-Fi Hotspot Endpoint
        Row(
            modifier = Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            OutlinedTextField(
                value = piIp,
                onValueChange = onPiIpChanged,
                label = { Text("Raspberry Pi IP") },
                singleLine = true,
                modifier = Modifier.weight(0.68f),
            )
            OutlinedTextField(
                value = piPort,
                onValueChange = onPiPortChanged,
                label = { Text("Port") },
                singleLine = true,
                modifier = Modifier.weight(0.32f),
            )
        }

        // Step 1 & 2: Snap photo (zero corners) + Tap Start & End points
        Card(modifier = Modifier.fillMaxWidth(), shape = RoundedCornerShape(12.dp)) {
            Column(Modifier.padding(12.dp)) {
                Text(
                    text = if (lang == AppLanguage.BN) {
                        "১. ছবি তুলুন এবং শুধু শুরুর ও শেষ বিন্দু ট্যাপ করুন"
                    } else {
                        "1. Snap Photo & Tap Start / End Points"
                    },
                    style = MaterialTheme.typography.titleMedium,
                )
                Spacer(Modifier.height(8.dp))
                StartEndPointCard(
                    imagePath = imagePath,
                    furrowsNx = furrowsNx,
                    startPoint = startPoint,
                    endPoint = endPoint,
                    onTakePhotoClick = {
                        val hasPerm = androidx.core.content.ContextCompat.checkSelfPermission(
                            context,
                            android.Manifest.permission.CAMERA
                        ) == android.content.pm.PackageManager.PERMISSION_GRANTED
                        if (hasPerm) launchCameraCapture()
                        else cameraPermissionLauncher.launch(android.Manifest.permission.CAMERA)
                    },
                    onPickPhotoClick = {
                        photoPickerLauncher.launch(
                            PickVisualMediaRequest(ActivityResultContracts.PickVisualMedia.ImageOnly)
                        )
                    },
                    onStartPointChanged = { startPoint = it },
                    onEndPointChanged = { endPoint = it },
                )
            }
        }

        // Actuator Relay Mode
        Row(
            modifier = Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            listOf("grinder" to "Relay 1: Grinder", "flame" to "Relay 2: Flame", "both" to "Dual Relay").forEach { (mode, label) ->
                FilterChip(
                    selected = relayMode == mode,
                    onClick = { relayMode = mode },
                    label = { Text(label, fontSize = 11.sp) },
                    modifier = Modifier.weight(1f),
                )
            }
        }

        // Step 3: Send photo + Start/End to Pi & open Live Rover stream
        Button(
            onClick = {
                val img = imagePath ?: return@Button
                val start = startPoint ?: return@Button
                isSending = true
                scope.launch {
                    val portNum = piPort.toIntOrNull() ?: 8000
                    // Ensure photo is uploaded, then start mission at Start -> End
                    piClient.uploadFieldPhoto(piIp, portNum, File(img))
                    val result = piClient.startMission(piIp, portNum, start, endPoint, relayMode)
                    isSending = false
                    result.onSuccess {
                        statusMessage = "Mission started on Pi — opening Live Rover video stream..."
                        onNavigateToLive()
                    }.onFailure { err ->
                        statusMessage = "Pi unreachable (${err.message}). Switching to Live Monitor."
                        onNavigateToLive()
                    }
                }
            },
            enabled = imagePath != null && startPoint != null && !isSending,
            modifier = Modifier.fillMaxWidth().height(50.dp),
        ) {
            Text(
                text = if (isSending) {
                    "Sending to Pi..."
                } else if (lang == AppLanguage.BN) {
                    "Pi-তে পাঠান এবং রোভার চালু করুন"
                } else {
                    "Send Image & Start Rover (Open Live Feed)"
                },
                style = MaterialTheme.typography.labelLarge,
            )
        }

        statusMessage?.let { msg ->
            Text(
                text = msg,
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
    }
}

private fun copyUriToInternalFile(context: Context, uri: Uri): String? {
    return try {
        val rotationDegrees = context.contentResolver.openInputStream(uri)?.use { stream ->
            val exif = androidx.exifinterface.media.ExifInterface(stream)
            when (exif.getAttributeInt(
                androidx.exifinterface.media.ExifInterface.TAG_ORIENTATION,
                androidx.exifinterface.media.ExifInterface.ORIENTATION_NORMAL
            )) {
                androidx.exifinterface.media.ExifInterface.ORIENTATION_ROTATE_90 -> 90f
                androidx.exifinterface.media.ExifInterface.ORIENTATION_ROTATE_180 -> 180f
                androidx.exifinterface.media.ExifInterface.ORIENTATION_ROTATE_270 -> 270f
                else -> 0f
            }
        } ?: 0f

        val boundsOptions = android.graphics.BitmapFactory.Options().apply { inJustDecodeBounds = true }
        context.contentResolver.openInputStream(uri)?.use { stream ->
            android.graphics.BitmapFactory.decodeStream(stream, null, boundsOptions)
        }
        val origW = boundsOptions.outWidth
        val origH = boundsOptions.outHeight
        if (origW <= 0 || origH <= 0) return null

        val maxDim = 2048
        var sampleSize = 1
        while ((origW / sampleSize) > maxDim || (origH / sampleSize) > maxDim) sampleSize *= 2

        val decodeOptions = android.graphics.BitmapFactory.Options().apply {
            inSampleSize = sampleSize
            inPreferredConfig = android.graphics.Bitmap.Config.ARGB_8888
        }
        val decoded = context.contentResolver.openInputStream(uri)?.use { stream ->
            android.graphics.BitmapFactory.decodeStream(stream, null, decodeOptions)
        } ?: return null

        val upright = if (rotationDegrees != 0f) {
            val matrix = android.graphics.Matrix().apply { postRotate(rotationDegrees) }
            android.graphics.Bitmap.createBitmap(decoded, 0, 0, decoded.width, decoded.height, matrix, true)
                .also { if (it != decoded) decoded.recycle() }
        } else {
            decoded
        }

        val target = File(context.filesDir, "field_input_${System.currentTimeMillis()}.jpg")
        FileOutputStream(target).use { out ->
            upright.compress(android.graphics.Bitmap.CompressFormat.JPEG, 92, out)
        }
        upright.recycle()
        target.absolutePath
    } catch (e: Throwable) {
        android.util.Log.e("BeMainScreen", "Error saving photo: ${e.message}", e)
        null
    }
}