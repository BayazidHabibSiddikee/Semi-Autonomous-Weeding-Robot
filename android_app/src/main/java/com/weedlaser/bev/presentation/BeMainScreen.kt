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
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Build
import androidx.compose.material.icons.filled.Info
import androidx.compose.material.icons.filled.LocationOn
import androidx.compose.material.icons.filled.Person
import androidx.compose.material.icons.filled.PlayArrow
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.Checkbox
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FilterChip
import androidx.compose.material3.FilterChipDefaults
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.NavigationBar
import androidx.compose.material3.NavigationBarItem
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
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
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import org.koin.androidx.compose.koinViewModel
import java.io.File
import java.io.FileOutputStream

enum class AppTab {
    CAPTURE, LIVE, CONTROL, PROJECT, ABOUT
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun MainAppContainer(viewModel: BeViewModel = koinViewModel()) {
    var selectedLanguage by rememberSaveable { mutableStateOf(AppLanguage.BN) }
    var currentTab by rememberSaveable { mutableStateOf(AppTab.CAPTURE) }

    CompositionLocalProvider(LocalAppLanguage provides selectedLanguage) {
        WeedLaserTheme {
            Scaffold(
                topBar = {
                    Column {
                        TopAppBar(
                            title = {
                                Text(
                                    text = Strings.appTitle(selectedLanguage),
                                    style = MaterialTheme.typography.titleMedium,
                                    fontWeight = FontWeight.Bold,
                                    maxLines = 1,
                                    overflow = androidx.compose.ui.text.style.TextOverflow.Ellipsis,
                                )
                            },
                            actions = {
                                TextButton(
                                    onClick = {
                                        selectedLanguage = if (selectedLanguage == AppLanguage.BN) {
                                            AppLanguage.EN
                                        } else {
                                            AppLanguage.BN
                                        }
                                    },
                                    modifier = Modifier.padding(end = 4.dp),
                                ) {
                                    Text(
                                        text = if (selectedLanguage == AppLanguage.BN) "English" else "বাংলা",
                                        fontWeight = FontWeight.SemiBold,
                                    )
                                }
                            },
                            colors = TopAppBarDefaults.topAppBarColors(
                                containerColor = MaterialTheme.colorScheme.surface,
                            ),
                        )
                        androidx.compose.material3.HorizontalDivider(
                            color = MaterialTheme.colorScheme.outlineVariant,
                        )
                    }
                },
                bottomBar = {
                    NavigationBar(containerColor = MaterialTheme.colorScheme.surface) {
                        NavigationBarItem(
                            selected = currentTab == AppTab.CAPTURE,
                            onClick = { currentTab = AppTab.CAPTURE },
                            icon = { Icon(Icons.Default.PlayArrow, contentDescription = "Launch") },
                            label = { Text(Strings.navLaunch(selectedLanguage), fontSize = 11.sp) }
                        )
                        NavigationBarItem(
                            selected = currentTab == AppTab.LIVE,
                            onClick = { currentTab = AppTab.LIVE },
                            icon = { Icon(Icons.Default.LocationOn, contentDescription = "Live Rover") },
                            label = { Text(Strings.navLive(selectedLanguage), fontSize = 11.sp) }
                        )
                        NavigationBarItem(
                            selected = currentTab == AppTab.CONTROL,
                            onClick = { currentTab = AppTab.CONTROL },
                            icon = { Icon(Icons.Default.Build, contentDescription = "Simpla Bot Control") },
                            label = { Text("Control", fontSize = 11.sp) }
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
                            onNavigateToLive = { currentTab = AppTab.LIVE },
                        )
                        AppTab.LIVE -> LiveRoverMonitorScreen(viewModel = viewModel)
                        AppTab.CONTROL -> SimplaControlScreen()
                        AppTab.PROJECT -> ProjectDetailsScreen()
                        AppTab.ABOUT -> AboutDeveloperScreen()
                    }
                }
            }
        }
    }
}

/**
 * Zero-corner Capture & Launch screen backed by BeViewModel so state survives tab switches and rotation:
 *   1. Connect / bind to Pi Wi-Fi hotspot (optional UDP :8081 auto-discovery & Bearer token).
 *   2. Snap 1 photo -> Pi auto-warps to 2D Top-Down BEV (/image + /bev_image) & detects real furrows.
 *   3. Tap Start (and optional End) directly on the warped BEV map.
 *   4. Launch mission (strictly gated on Pi BEV upload + confidence >= 45% + Start pin).
 */
@Composable
fun BeMainScreen(
    viewModel: BeViewModel = koinViewModel(),
    onNavigateToLive: () -> Unit = {},
) {
    val lang = LocalAppLanguage.current
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    var pendingCameraUri by remember { mutableStateOf<Uri?>(null) }

    val photoPickerLauncher = rememberLauncherForActivityResult(
        contract = ActivityResultContracts.PickVisualMedia()
    ) { uri: Uri? ->
        if (uri != null) {
            scope.launch {
                val copiedPath = withContext(Dispatchers.IO) { copyUriToInternalFile(context, uri) }
                if (copiedPath != null) viewModel.onNewFieldPhoto(copiedPath)
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
                if (copiedPath != null) viewModel.onNewFieldPhoto(copiedPath)
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
        // Pi Wi-Fi Hotspot Endpoint + Bind & Discover tools
        Row(
            modifier = Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            OutlinedTextField(
                value = viewModel.piIp,
                onValueChange = viewModel::updatePiIp,
                label = { Text(Strings.piIpLabel(lang)) },
                singleLine = true,
                modifier = Modifier.weight(0.68f),
            )
            OutlinedTextField(
                value = viewModel.piPortText,
                onValueChange = viewModel::updatePiPortText,
                label = { Text(Strings.piPortLabel(lang)) },
                singleLine = true,
                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number),
                modifier = Modifier.weight(0.32f),
            )
        }

        OutlinedTextField(
            value = viewModel.apiToken,
            onValueChange = viewModel::updateApiToken,
            label = { Text(Strings.apiTokenLabel(lang)) },
            singleLine = true,
            visualTransformation = PasswordVisualTransformation(),
            modifier = Modifier.fillMaxWidth(),
        )

        Row(
            modifier = Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            OutlinedButton(
                onClick = viewModel::bindPiWifiHotspot,
                modifier = Modifier.weight(1f),
            ) {
                Text(Strings.bindWifiButton(lang, viewModel.wifiBound), maxLines = 1)
            }
            OutlinedButton(
                onClick = viewModel::discoverPiOnLan,
                enabled = !viewModel.isDiscovering,
                modifier = Modifier.weight(1f),
            ) {
                Text(Strings.discoverPiButton(lang), maxLines = 1)
            }
        }

        if (viewModel.discoveredDevices.isNotEmpty()) {
            Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
                viewModel.discoveredDevices.forEach { dev ->
                    TextButton(onClick = { viewModel.selectDiscoveredDevice(dev) }) {
                        Text("${dev.name} (${dev.ipAddress}:${dev.port})")
                    }
                }
            }
        }

        // Step 1 & 2: Snap photo -> Warped 2D Top-Down BEV -> Tap Start & End points
        Card(modifier = Modifier.fillMaxWidth(), shape = RoundedCornerShape(12.dp)) {
            Column(Modifier.padding(12.dp)) {
                Text(
                    text = Strings.step1Header(lang),
                    style = MaterialTheme.typography.titleMedium,
                )
                Spacer(Modifier.height(8.dp))
                StartEndPointCard(
                    bevImagePath = viewModel.bevImagePath,
                    isPiBev = viewModel.isPiBevReady,
                    isUploading = viewModel.isUploading,
                    furrowsNx = viewModel.furrowsNx,
                    startPoint = viewModel.startPoint,
                    endPoint = viewModel.endPoint,
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
                    onStartPointChanged = viewModel::updateStartPoint,
                    onEndPointChanged = viewModel::updateEndPoint,
                )

                if (viewModel.sourcePhotoPath != null && !viewModel.isPiBevReady && !viewModel.isUploading) {
                    Spacer(Modifier.height(8.dp))
                    OutlinedButton(
                        onClick = viewModel::uploadCurrentPhotoToPi,
                        modifier = Modifier.fillMaxWidth(),
                    ) {
                        Text(Strings.reuploadToPi(lang))
                    }
                }
            }
        }

        // Safe Navigation-Only default + Actuator Relay Modes
        Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                listOf(
                    "nav_only" to Strings.relayNavOnly(lang),
                    "grinder" to Strings.relayGrinder(lang),
                ).forEach { (mode, label) ->
                    FilterChip(
                        selected = viewModel.relayMode == mode,
                        onClick = { viewModel.updateRelayMode(mode) },
                        label = { Text(label, fontSize = 11.sp, maxLines = 1) },
                        modifier = Modifier.weight(1f),
                    )
                }
            }
            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                listOf(
                    "flame" to Strings.relayFlame(lang),
                    "both" to Strings.relayDual(lang),
                ).forEach { (mode, label) ->
                    FilterChip(
                        selected = viewModel.relayMode == mode,
                        onClick = { viewModel.updateRelayMode(mode) },
                        label = { Text(label, fontSize = 11.sp, maxLines = 1) },
                        modifier = Modifier.weight(1f),
                    )
                }
            }
            if (viewModel.relayMode != "nav_only") {
                Text(
                    text = Strings.treatmentInterlockHint(lang),
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.error,
                )
            }
        }

        // Explicit Operator Confirmation before launching physical motion
        Row(
            modifier = Modifier.fillMaxWidth(),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(6.dp),
        ) {
            Checkbox(
                checked = viewModel.operatorConfirmed,
                onCheckedChange = viewModel::updateOperatorConfirmed,
            )
            Text(
                text = Strings.operatorConfirmLabel(lang),
                style = MaterialTheme.typography.bodySmall,
                modifier = Modifier.weight(1f),
            )
        }

        // Error card (never hidden or swallowed)
        viewModel.errorMessage?.let { err ->
            Card(
                colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.errorContainer),
                modifier = Modifier.fillMaxWidth(),
            ) {
                Text(
                    text = err,
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onErrorContainer,
                    modifier = Modifier.padding(12.dp),
                )
            }
        }

        // Step 3: Strictly gated Launch button (only navigates to Live tab on real Pi success)
        Button(
            onClick = { viewModel.launchMission(onSuccessNavigateToLive = onNavigateToLive) },
            enabled = viewModel.canStartMission,
            modifier = Modifier
                .fillMaxWidth()
                .height(50.dp),
        ) {
            Text(
                text = Strings.launchMissionButton(lang, viewModel.isStartingMission),
                style = MaterialTheme.typography.labelLarge,
            )
        }

        if (!viewModel.canStartMission) {
            Text(
                text = Strings.launchDisabledHint(lang),
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }

        viewModel.statusMessage?.let { msg ->
            Text(
                text = msg,
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.primary,
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