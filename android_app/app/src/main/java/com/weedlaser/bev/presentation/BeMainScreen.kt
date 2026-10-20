package com.weedlaser.bev.presentation

import android.content.ClipData
import android.content.ClipboardManager
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
import androidx.compose.material.icons.filled.Person
import androidx.compose.material.icons.filled.PlayArrow
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FilterChip
import androidx.compose.material3.FilterChipDefaults
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.NavigationBar
import androidx.compose.material3.NavigationBarItem
import androidx.compose.material3.OutlinedButton
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
import com.weedlaser.bev.domain.model.Field
import com.weedlaser.bev.domain.model.FieldCorners
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import org.koin.androidx.compose.koinViewModel
import java.io.File
import java.io.FileOutputStream

enum class AppTab {
    PLANNER, PROJECT, ABOUT
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun MainAppContainer(viewModel: BeViewModel = koinViewModel()) {
    var selectedLanguage by rememberSaveable { mutableStateOf(AppLanguage.BN) }
    var currentTab by rememberSaveable { mutableStateOf(AppTab.PLANNER) }

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
                            // EN / BN Language Switcher
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
                            selected = currentTab == AppTab.PLANNER,
                            onClick = { currentTab = AppTab.PLANNER },
                            icon = { Icon(Icons.Default.PlayArrow, contentDescription = "Planner") },
                            label = { Text(Strings.navPlanner(selectedLanguage), fontSize = 11.sp) }
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
                        AppTab.PLANNER -> BeMainScreen(viewModel = viewModel)
                        AppTab.PROJECT -> ProjectDetailsScreen()
                        AppTab.ABOUT -> AboutDeveloperScreen()
                    }
                }
            }
        }
    }
}

/**
 * BEV Planner screen: photo + corners, field config, generate, send / export.
 */
@Composable
fun BeMainScreen(viewModel: BeViewModel = koinViewModel()) {
    val lang = LocalAppLanguage.current
    val context = LocalContext.current
    val scope = rememberCoroutineScope()

    var imagePath by rememberSaveable { mutableStateOf<String?>(null) }
    var corners by remember { mutableStateOf<FieldCorners?>(null) }
    var field by remember {
        mutableStateOf(Field(widthM = 6.0, lengthM = 8.0, totalRows = 10, rowSpacingM = 0.6))
    }
    var piIp by rememberSaveable { mutableStateOf("192.168.4.1") }
    var isDraggingCorner by remember { mutableStateOf(false) }

    val photoPickerLauncher = rememberLauncherForActivityResult(
        contract = ActivityResultContracts.PickVisualMedia()
    ) { uri: Uri? ->
        if (uri != null) {
            scope.launch {
                val copiedPath = withContext(Dispatchers.IO) {
                    copyUriToInternalFile(context, uri)
                }
                if (copiedPath != null) {
                    imagePath = copiedPath
                    corners = null // reset corners for new photo
                }
            }
        }
    }

    Column(
        modifier = Modifier
            .fillMaxSize()
            .verticalScroll(rememberScrollState(), enabled = !isDraggingCorner)
            .padding(16.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        Card(modifier = Modifier.fillMaxWidth(), shape = RoundedCornerShape(12.dp)) {
            Column(Modifier.padding(12.dp)) {
                Text(Strings.step1Title(lang), style = MaterialTheme.typography.titleMedium)
                Spacer(Modifier.height(8.dp))
                CornerSelectionCard(
                    imagePath = imagePath,
                    corners = corners,
                    onPickPhotoClick = {
                        photoPickerLauncher.launch(
                            PickVisualMediaRequest(ActivityResultContracts.PickVisualMedia.ImageOnly)
                        )
                    },
                    onCornersChanged = { corners = it },
                    onDraggingChanged = { isDraggingCorner = it },
                )
            }
        }

        Card(modifier = Modifier.fillMaxWidth(), shape = RoundedCornerShape(12.dp)) {
            Column(Modifier.padding(12.dp)) {
                Text(Strings.step2Title(lang), style = MaterialTheme.typography.titleMedium)
                Spacer(Modifier.height(8.dp))
                FieldConfigInputs(field) { field = it }
            }
        }

        Button(
            onClick = {
                val img = imagePath ?: return@Button
                val c = corners ?: return@Button
                if (!c.isValid()) return@Button
                viewModel.processAndGenerate(img, c, field)
            },
            enabled = imagePath != null && corners != null && !viewModel.isProcessing,
            modifier = Modifier.fillMaxWidth(),
        ) {
            Text(
                Strings.generateMission(lang, viewModel.isProcessing),
                style = MaterialTheme.typography.labelLarge,
            )
        }

        Row(
            horizontalArrangement = Arrangement.spacedBy(8.dp),
            modifier = Modifier.fillMaxWidth(),
        ) {
            OutlinedButton(
                onClick = { viewModel.discoverPi() },
                enabled = !viewModel.isDiscovering,
                modifier = Modifier.weight(1f),
            ) {
                Text(
                    if (viewModel.isDiscovering) "Searching…"
                    else viewModel.piInfo?.let { "Pi: ${it.name} (${it.host})" } ?: "Find Pi"
                )
            }
        }

        when (val o = viewModel.outcome) {
            is BevOutcome.Success ->
                BeSuccessPanel(
                    o = o,
                    piIp = viewModel.piInfo?.host ?: piIp,
                    status = viewModel.missionStatus,
                    piResult = viewModel.piResult,
                    piBaseUrl = viewModel.piInfo?.baseUrl,
                    isUploading = viewModel.isUploading,
                    simStatus = viewModel.simStatus,
                    onSendImage = {
                        val img = imagePath
                        val c = corners
                        if (img != null && c != null) {
                            viewModel.sendImageToPi(img, c, field)
                        }
                    },
                    onSend = { viewModel.sendAndTrack(o.mission, viewModel.piInfo?.host ?: piIp) },
                    onCopyJson = {
                        val jsonStr = viewModel.missionToJson(o.mission)
                        val clipboard = context.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
                        clipboard.setPrimaryClip(ClipData.newPlainText("Mission JSON", jsonStr))
                        Toast.makeText(context, Strings.jsonCopied(lang), Toast.LENGTH_SHORT).show()
                    }
                )
            is BevOutcome.Error -> BeErrorPanel(o.message, viewModel::reset)
            BevOutcome.Idle -> BeIdleHint()
        }
    }
}

private fun copyUriToInternalFile(context: Context, uri: Uri): String? {
    return try {
        // Read image bounds first
        val boundsOptions = android.graphics.BitmapFactory.Options().apply {
            inJustDecodeBounds = true
        }
        context.contentResolver.openInputStream(uri)?.use { stream ->
            android.graphics.BitmapFactory.decodeStream(stream, null, boundsOptions)
        }

        val origW = boundsOptions.outWidth
        val origH = boundsOptions.outHeight
        if (origW <= 0 || origH <= 0) return null

        // Calculate sample size to limit dimensions to max 2048x2048 (safeguards high-megapixel phone cameras)
        val maxDim = 2048
        var sampleSize = 1
        while ((origW / sampleSize) > maxDim || (origH / sampleSize) > maxDim) {
            sampleSize *= 2
        }

        val decodeOptions = android.graphics.BitmapFactory.Options().apply {
            inSampleSize = sampleSize
            inPreferredConfig = android.graphics.Bitmap.Config.ARGB_8888
        }

        val bitmap = context.contentResolver.openInputStream(uri)?.use { stream ->
            android.graphics.BitmapFactory.decodeStream(stream, null, decodeOptions)
        } ?: return null

        val target = File(context.filesDir, "field_input_${System.currentTimeMillis()}.jpg")
        FileOutputStream(target).use { out ->
            bitmap.compress(android.graphics.Bitmap.CompressFormat.JPEG, 92, out)
        }
        bitmap.recycle()
        target.absolutePath
    } catch (e: Throwable) {
        android.util.Log.e("BeMainScreen", "Error saving photo: ${e.message}", e)
        null
    }
}