import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  Camera,
  Upload,
  Image as ImageIcon,
  Play,
  RotateCcw,
  Crosshair,
  Send,
  Copy,
  Check,
  X,
} from 'lucide-react';
import { AppLanguage } from '../i18n/strings';
import {
  AutoFieldAnalysis,
  FurrowWaypoint,
  NormalizedPoint,
  buildTwoPointSerpentineRoute,
  runAutomaticFieldPipeline,
} from '../domain/autoFieldPipeline';
import {
  BevPixelPoint,
  PiMissionPlanJson,
  dispatchMissionPlanToPi,
  normalizedToPixelBev,
  uploadFieldPhotoToPi,
} from '../domain/piMissionProtocol';
import { LaunchMissionConfig, RelayMode } from '../domain/roverLiveEngine';

interface Props {
  lang: AppLanguage;
  piHost: string;
  onPiHostChange: (host: string) => void;
  apiToken: string;
  onApiTokenChange: (token: string) => void;
  onLaunchRover: (config: LaunchMissionConfig) => void;
}

type PointSelectionMode = 'START' | 'END';
type BevSourceKind = 'LOCAL_PREVIEW' | 'PI_SERVER';

function fitRect(containerW: number, containerH: number, imgW: number, imgH: number) {
  const aspect = imgW / imgH;
  let drawW = containerW;
  let drawH = containerH;
  if (drawW / drawH > aspect) drawW = drawH * aspect;
  else drawH = drawW / aspect;
  return {
    drawW,
    drawH,
    dx: (containerW - drawW) / 2,
    dy: (containerH - drawH) / 2,
  };
}

function imageElementToJpegBlob(img: HTMLImageElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    const canvas = document.createElement('canvas');
    canvas.width = img.naturalWidth || img.width || 640;
    canvas.height = img.naturalHeight || img.height || 480;
    const ctx = canvas.getContext('2d');
    if (!ctx) {
      reject(new Error('Canvas 2D context unavailable'));
      return;
    }
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    canvas.toBlob(
      (blob) => {
        if (blob) resolve(blob);
        else reject(new Error('Failed to encode field image as JPEG'));
      },
      'image/jpeg',
      0.92
    );
  });
}

export const CaptureLaunchScreen: React.FC<Props> = ({
  lang,
  piHost,
  onPiHostChange,
  apiToken,
  onApiTokenChange,
  onLaunchRover,
}) => {
  const isBn = lang === 'BN';

  const [imageUrl, setImageUrl] = useState<string>('/media/field_render.png');
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [sourceImage, setSourceImage] = useState<HTMLImageElement | null>(null);

  const [analysis, setAnalysis] = useState<AutoFieldAnalysis | null>(null);
  const [bevSource, setBevSource] = useState<BevSourceKind>('LOCAL_PREVIEW');
  const [bevImageUrl, setBevImageUrl] = useState<string | null>(null);
  const [bevDims, setBevDims] = useState<{ width: number; height: number }>({ width: 640, height: 440 });
  const [bevImgError, setBevImgError] = useState<string | null>(null);

  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [isUploadingToPi, setIsUploadingToPi] = useState(false);
  const [isLaunchingPi, setIsLaunchingPi] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [sendStatus, setSendStatus] = useState<string | null>(null);
  const [copiedJson, setCopiedJson] = useState(false);

  // Start & End stored directly as 0.0–1.0 normalized coordinates relative to the BEV image dimensions
  const [pointMode, setPointMode] = useState<PointSelectionMode>('START');
  const [startPoint, setStartPoint] = useState<NormalizedPoint | null>(null);
  const [endPoint, setEndPoint] = useState<NormalizedPoint | null>(null);
  const [hoverPoint, setHoverPoint] = useState<NormalizedPoint | null>(null);
  const [relayMode, setRelayMode] = useState<RelayMode>('grinder');

  const sourceCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const overlayCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const cameraInputRef = useRef<HTMLInputElement | null>(null);
  const objectUrlRef = useRef<string | null>(null);

  useEffect(() => {
    return () => {
      if (objectUrlRef.current) {
        URL.revokeObjectURL(objectUrlRef.current);
        objectUrlRef.current = null;
      }
    };
  }, []);

  // Run local ExG + Plot Quad BEV preview whenever a photo is captured/picked
  useEffect(() => {
    let cancelled = false;
    setIsAnalyzing(true);
    setErrorMsg(null);
    setSendStatus(null);
    setBevImgError(null);

    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => {
      if (cancelled) return;
      setSourceImage(img);
      try {
        const result = runAutomaticFieldPipeline(img, 640, 440);
        if (cancelled) return;
        if (objectUrlRef.current) {
          URL.revokeObjectURL(objectUrlRef.current);
          objectUrlRef.current = null;
        }
        setAnalysis(result);
        setBevSource('LOCAL_PREVIEW');
        setBevImageUrl(result.bevDataUrl);
        setBevDims({ width: result.bevWidth, height: result.bevHeight });
        setStartPoint(null);
        setEndPoint(null);
        setPointMode('START');
        if (!result.ready) {
          setErrorMsg(
            `Row detection confidence too low (${Math.round(result.confidence * 100)}%, ${result.furrowsNx.length} furrows). Capture a clearer field photo with visible crop ridges.`
          );
        }
      } catch (err) {
        if (!cancelled) {
          setErrorMsg(err instanceof Error ? err.message : 'Failed to auto-detect field boundary');
        }
      } finally {
        if (!cancelled) setIsAnalyzing(false);
      }
    };
    img.onerror = () => {
      if (!cancelled) {
        setIsAnalyzing(false);
        setErrorMsg('Could not load selected field image.');
      }
    };
    img.src = imageUrl;

    return () => {
      cancelled = true;
    };
  }, [imageUrl]);

  // Derived pixel coordinates for canvas rendering & telemetry display
  const startPixel: BevPixelPoint | null = useMemo(
    () => (startPoint ? normalizedToPixelBev(startPoint, bevDims.width, bevDims.height) : null),
    [startPoint, bevDims.width, bevDims.height]
  );

  const endPixel: BevPixelPoint | null = useMemo(
    () => (endPoint ? normalizedToPixelBev(endPoint, bevDims.width, bevDims.height) : null),
    [endPoint, bevDims.width, bevDims.height]
  );

  // Mission Plan JSON expected by Pi POST /start_mission (0.0–1.0 coordinates)
  const missionPlanJson: PiMissionPlanJson | null = useMemo(() => {
    if (!startPoint) return null;
    return {
      start: { nx: startPoint.nx, ny: startPoint.ny },
      end: endPoint ? { nx: endPoint.nx, ny: endPoint.ny } : null,
      relay_mode: relayMode,
    };
  }, [startPoint, endPoint, relayMode]);

  const missionPlanJsonString = useMemo(
    () => (missionPlanJson ? JSON.stringify(missionPlanJson, null, 2) : null),
    [missionPlanJson]
  );

  const routeWaypoints: FurrowWaypoint[] = useMemo(() => {
    if (!analysis || !startPoint) return [];
    return buildTwoPointSerpentineRoute(analysis.furrowsNx, startPoint, endPoint);
  }, [analysis, startPoint, endPoint]);

  // Draw Step 1 Source Photo with Auto-Detected Boundary (Read-Only)
  useEffect(() => {
    const canvas = sourceCanvasRef.current;
    if (!canvas || !sourceImage || !analysis) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const w = canvas.width;
    const h = canvas.height;
    ctx.fillStyle = '#0F172A';
    ctx.fillRect(0, 0, w, h);

    const { drawW, drawH, dx, dy } = fitRect(w, h, sourceImage.naturalWidth, sourceImage.naturalHeight);
    ctx.drawImage(sourceImage, dx, dy, drawW, drawH);

    const c = analysis.detectedCorners;
    const pts = [c.topLeft, c.topRight, c.bottomRight, c.bottomLeft].map((p) => ({
      x: (p.x / sourceImage.naturalWidth) * drawW + dx,
      y: (p.y / sourceImage.naturalHeight) * drawH + dy,
    }));

    ctx.beginPath();
    ctx.moveTo(pts[0].x, pts[0].y);
    pts.slice(1).forEach((p) => ctx.lineTo(p.x, p.y));
    ctx.closePath();
    ctx.fillStyle = 'rgba(6, 182, 212, 0.12)';
    ctx.fill();
    ctx.strokeStyle = '#06B6D4';
    ctx.lineWidth = 2.5;
    ctx.stroke();

    pts.forEach((p) => {
      ctx.fillStyle = '#06B6D4';
      ctx.beginPath();
      ctx.arc(p.x, p.y, 4.5, 0, Math.PI * 2);
      ctx.fill();
    });

    ctx.fillStyle = 'rgba(15, 23, 42, 0.84)';
    ctx.fillRect(8, 8, 250, 24);
    ctx.fillStyle = '#E2E8F0';
    ctx.font = '600 11px "IBM Plex Mono", monospace';
    ctx.fillText(
      bevSource === 'PI_SERVER' ? 'PI SERVER BOUNDARY QUAD' : 'AUTO ExG + PLOT QUAD BOUNDARY',
      14,
      24
    );
  }, [sourceImage, analysis, bevSource]);

  // Draw transparent vector overlay on top of the BEV <img>
  useEffect(() => {
    const canvas = overlayCanvasRef.current;
    if (!canvas || !analysis) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const w = canvas.width;
    const h = canvas.height;
    ctx.clearRect(0, 0, w, h);

    ctx.fillStyle = 'rgba(11, 17, 23, 0.22)';
    ctx.fillRect(0, 0, w, h);

    // 1. Detected Crop Ridges
    analysis.ridgesNx.forEach((rx, idx) => {
      const x = rx * w;
      ctx.fillStyle = 'rgba(34, 197, 94, 0.16)';
      ctx.fillRect(x - 12, 0, 24, h);
      ctx.fillStyle = 'rgba(187, 247, 208, 0.92)';
      ctx.font = '600 10px "IBM Plex Mono", monospace';
      ctx.fillText(`R${idx + 1}`, x - 7, 16);
    });

    // 2. Traversable Furrows
    analysis.furrowsNx.forEach((fx, idx) => {
      const x = fx * w;
      ctx.strokeStyle = 'rgba(245, 158, 11, 0.62)';
      ctx.lineWidth = 1.5;
      ctx.setLineDash([6, 5]);
      ctx.beginPath();
      ctx.moveTo(x, 22);
      ctx.lineTo(x, h - 18);
      ctx.stroke();
      ctx.setLineDash([]);

      ctx.fillStyle = 'rgba(253, 230, 138, 0.95)';
      ctx.font = '600 10px "IBM Plex Mono", monospace';
      ctx.fillText(`F${idx + 1}`, x - 7, h - 6);
    });

    // 3. Generated Boustrophedon Serpentine Route from Start -> End
    if (routeWaypoints.length > 1) {
      for (let i = 0; i < routeWaypoints.length - 1; i++) {
        const a = routeWaypoints[i];
        const b = routeWaypoints[i + 1];
        const isUTurn = Math.abs(b.nx - a.nx) > Math.abs(b.ny - a.ny);
        ctx.strokeStyle = isUTurn ? '#F59E0B' : '#06B6D4';
        ctx.lineWidth = isUTurn ? 2.5 : 3.2;
        ctx.beginPath();
        ctx.moveTo(a.nx * w, a.ny * h);
        ctx.lineTo(b.nx * w, b.ny * h);
        ctx.stroke();

        if (!isUTurn) {
          const mx = ((a.nx + b.nx) / 2) * w;
          const my = ((a.ny + b.ny) / 2) * h;
          const dir = b.ny < a.ny ? -1 : 1;
          ctx.fillStyle = '#06B6D4';
          ctx.beginPath();
          ctx.moveTo(mx, my + dir * 7);
          ctx.lineTo(mx - 5, my - dir * 5);
          ctx.lineTo(mx + 5, my - dir * 5);
          ctx.closePath();
          ctx.fill();
        }
      }
    }

    // 4. Hover crosshair + live normalized (0.0–1.0) & pixel readout
    if (hoverPoint) {
      const hx = hoverPoint.nx * w;
      const hy = hoverPoint.ny * h;
      ctx.strokeStyle = 'rgba(226, 232, 240, 0.45)';
      ctx.lineWidth = 1;
      ctx.setLineDash([4, 4]);
      ctx.beginPath();
      ctx.moveTo(hx, 0);
      ctx.lineTo(hx, h);
      ctx.moveTo(0, hy);
      ctx.lineTo(w, hy);
      ctx.stroke();
      ctx.setLineDash([]);

      const hudText = `${pointMode} · (${hoverPoint.nx.toFixed(3)}, ${hoverPoint.ny.toFixed(3)}) [${Math.round(hoverPoint.nx * 100)}%, ${Math.round(hoverPoint.ny * 100)}%]`;
      ctx.font = '600 11px "IBM Plex Mono", monospace';
      const boxW = ctx.measureText(hudText).width + 16;
      ctx.fillStyle = 'rgba(15, 23, 42, 0.88)';
      ctx.fillRect(10, 10, boxW, 24);
      ctx.fillStyle = '#F8FAFC';
      ctx.fillText(hudText, 18, 26);
    }

    // 5. Start (S) & End (E) pins placed from stored 0.0–1.0 coordinates
    const drawMarker = (
      normPt: NormalizedPoint,
      letter: 'S' | 'E',
      fill: string
    ) => {
      const x = normPt.nx * w;
      const y = normPt.ny * h;
      ctx.beginPath();
      ctx.arc(x, y, 13, 0, Math.PI * 2);
      ctx.fillStyle = fill;
      ctx.fill();
      ctx.lineWidth = 2.5;
      ctx.strokeStyle = '#FFFFFF';
      ctx.stroke();

      ctx.fillStyle = '#FFFFFF';
      ctx.font = '700 11px "IBM Plex Sans", sans-serif';
      ctx.fillText(letter, x - 3.5, y + 4);

      const tagText = `${letter} (${normPt.nx.toFixed(2)}, ${normPt.ny.toFixed(2)})`;
      ctx.font = '600 10px "IBM Plex Mono", monospace';
      const tw = ctx.measureText(tagText).width + 10;
      const tx = x + 17 + tw > w ? x - 17 - tw : x + 17;
      const ty = Math.max(8, Math.min(h - 24, y - 10));
      ctx.fillStyle = 'rgba(15, 23, 42, 0.88)';
      ctx.fillRect(tx, ty, tw, 20);
      ctx.fillStyle = '#F8FAFC';
      ctx.fillText(tagText, tx + 5, ty + 13.5);
    };

    if (startPoint) {
      drawMarker(startPoint, 'S', 'rgba(22, 163, 74, 0.96)');
    }
    if (endPoint) {
      drawMarker(endPoint, 'E', 'rgba(220, 38, 38, 0.96)');
    }
  }, [analysis, bevDims, startPoint, endPoint, hoverPoint, pointMode, routeWaypoints]);

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setSelectedFile(file);
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === 'string') setImageUrl(reader.result);
    };
    reader.readAsDataURL(file);
  };

  /**
   * Upload current field photo to Pi's POST /image and display the Pi's returned BEV image.
   */
  const handleUploadToPi = async () => {
    if (!sourceImage || isUploadingToPi) return;
    setIsUploadingToPi(true);
    setErrorMsg(null);
    setSendStatus(null);
    setBevImgError(null);

    try {
      const blob = selectedFile ?? (await imageElementToJpegBlob(sourceImage));
      const filename = selectedFile?.name || 'field_photo.jpg';
      const result = await uploadFieldPhotoToPi(
        piHost,
        blob,
        filename,
        sourceImage.naturalWidth || 640,
        sourceImage.naturalHeight || 480,
        apiToken
      );

      if (objectUrlRef.current) {
        URL.revokeObjectURL(objectUrlRef.current);
        objectUrlRef.current = null;
      }
      if (result.isObjectUrl) {
        objectUrlRef.current = result.bevImageUrl;
      }

      setAnalysis(result.analysis);
      setBevSource('PI_SERVER');
      setBevImageUrl(result.bevImageUrl);
      setBevDims({ width: result.analysis.bevWidth, height: result.analysis.bevHeight });
      setStartPoint(null);
      setEndPoint(null);
      setPointMode('START');

      const confPct = Math.round(result.analysis.confidence * 100);
      if (result.analysis.ready) {
        setSendStatus(
          `Pi BEV received (${result.analysis.bevWidth}×${result.analysis.bevHeight}px, ${result.analysis.furrowsNx.length} furrows, ${confPct}% confidence). Click on the BEV image to place Start & End.`
        );
      } else {
        setErrorMsg(
          `Pi returned low confidence (${confPct}%, ${result.analysis.furrowsNx.length} furrows). Recapture a clearer crop-row photo before starting.`
        );
      }
    } catch (err) {
      setErrorMsg(
        err instanceof Error
          ? `${err.message}. Showing local BEV preview until Pi hotspot is reachable.`
          : 'Could not reach Pi /image endpoint.'
      );
    } finally {
      setIsUploadingToPi(false);
    }
  };

  /**
   * Compute normalized percentage coordinates (0.0–1.0) relative to the BEV image container dimensions.
   */
  const computeRelativePercent = (e: React.MouseEvent<HTMLDivElement>): NormalizedPoint | null => {
    const rect = e.currentTarget.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return null;
    const nx = Number(Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width)).toFixed(4));
    const ny = Number(Math.max(0, Math.min(1, (e.clientY - rect.top) / rect.height)).toFixed(4));
    return { nx, ny };
  };

  /**
   * onClick handler on the BEV image container placing Start / End as 0.0–1.0 percentages.
   */
  const handleImageContainerClick = (e: React.MouseEvent<HTMLDivElement>) => {
    const pt = computeRelativePercent(e);
    if (!pt) return;
    if (pointMode === 'START') {
      setStartPoint(pt);
      setPointMode('END');
    } else {
      setEndPoint(pt);
      setPointMode('START');
    }
  };

  const handleImageContainerMouseMove = (e: React.MouseEvent<HTMLDivElement>) => {
    setHoverPoint(computeRelativePercent(e));
  };

  const handleBevImgLoad = (e: React.SyntheticEvent<HTMLImageElement>) => {
    const img = e.currentTarget;
    setBevImgError(null);
    if (img.naturalWidth > 0 && img.naturalHeight > 0) {
      setBevDims((prev) =>
        prev.width === img.naturalWidth && prev.height === img.naturalHeight
          ? prev
          : { width: img.naturalWidth, height: img.naturalHeight }
      );
    }
  };

  const handleCopyMissionJson = async () => {
    if (!missionPlanJsonString) return;
    try {
      await navigator.clipboard.writeText(missionPlanJsonString);
      setCopiedJson(true);
      window.setTimeout(() => setCopiedJson(false), 1800);
    } catch {
      setErrorMsg('Clipboard unavailable in this browser context.');
    }
  };

  const canLaunch = Boolean(
    analysis &&
      analysis.ready &&
      startPoint &&
      missionPlanJson &&
      !isAnalyzing &&
      !isUploadingToPi &&
      !isLaunchingPi
  );

  const handleSendAndStart = async () => {
    if (!analysis || !analysis.ready || !startPoint || !missionPlanJson) return;
    setErrorMsg(null);

    if (bevSource === 'PI_SERVER') {
      setIsLaunchingPi(true);
      try {
        const ack = await dispatchMissionPlanToPi(piHost, missionPlanJson, apiToken);
        setSendStatus(
          `Pi started mission (${ack.waypoints ?? routeWaypoints.length} waypoints) — opening Live Pi stream...`
        );
        onLaunchRover({
          analysis,
          startPoint,
          endPoint,
          relayMode,
          targetMode: 'LIVE_PI',
          seed: 42,
        });
      } catch (err) {
        setErrorMsg(err instanceof Error ? err.message : 'Failed to start mission on Raspberry Pi');
      } finally {
        setIsLaunchingPi(false);
      }
      return;
    }

    setSendStatus(
      `Mission JSON prepared from BEV (${startPoint.nx.toFixed(3)}, ${startPoint.ny.toFixed(3)}) — launching onboard simulator...`
    );
    onLaunchRover({
      analysis,
      startPoint,
      endPoint,
      relayMode,
      targetMode: 'SIMULATOR',
      seed: 42,
    });
  };

  const coveredFurrows = new Set(routeWaypoints.map((w) => w.furrowIndex)).size;

  return (
    <div className="space-y-6">
      {/* Compact Page Heading */}
      <div className="flex flex-wrap items-end justify-between gap-4 border-b border-slate-200 pb-4">
        <div>
          <h1 className="text-xl font-bold tracking-tight text-slate-900">
            {isBn
              ? '১ ছবি তুলুন, BEV ম্যাপে শুরু ও শেষ বিন্দু ট্যাপ করুন'
              : 'Capture Field Photo & Tap Start / End on Top-Down BEV Map'}
          </h1>
          <p className="mt-1 text-sm text-slate-600">
            {isBn
              ? 'ছবিটি Pi সার্ভারের /image-এ পাঠিয়ে BEV ছবি আনুন, তারপর ছবিতে ক্লিক করে 0.0–1.0 স্থানাঙ্ক থেকে Pi মিশন JSON তৈরি করুন।'
              : 'Upload to Pi (/image) to receive the warped BEV image, click on the image container to store Start & End coordinates (0.0–1.0), and send the Pi mission JSON.'}
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <input
            ref={cameraInputRef}
            type="file"
            accept="image/*"
            capture="environment"
            onChange={handleFileChange}
            className="hidden"
          />
          <input
            ref={fileInputRef}
            type="file"
            accept="image/*"
            onChange={handleFileChange}
            className="hidden"
          />
          <button
            type="button"
            onClick={() => cameraInputRef.current?.click()}
            className="inline-flex items-center gap-2 rounded-lg bg-slate-900 px-3.5 py-2 text-xs font-semibold text-white transition hover:bg-slate-800 whitespace-nowrap shrink-0"
          >
            <Camera className="h-3.5 w-3.5" />
            {isBn ? 'ছবি তুলুন' : 'Snap Field Photo'}
          </button>
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            className="inline-flex items-center gap-2 rounded-lg border border-slate-300 bg-white px-3.5 py-2 text-xs font-semibold text-slate-700 transition hover:bg-slate-50 whitespace-nowrap shrink-0"
          >
            <Upload className="h-3.5 w-3.5" />
            {isBn ? 'ফটো আপলোড' : 'Upload Photo'}
          </button>
          <button
            type="button"
            onClick={() => {
              setSelectedFile(null);
              setImageUrl('/media/field_render.png');
            }}
            className="inline-flex items-center gap-2 rounded-lg border border-slate-300 bg-white px-3.5 py-2 text-xs font-medium text-slate-600 transition hover:bg-slate-50 whitespace-nowrap shrink-0"
          >
            <ImageIcon className="h-3.5 w-3.5" />
            {isBn ? 'নমুনা জমি' : 'Sample Field'}
          </button>
        </div>
      </div>

      {errorMsg && (
        <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">
          {errorMsg}
        </div>
      )}

      {/* Main 2-Column Split: Left = Source Boundary & Pi Upload/Launch, Right = BEV Image Container + Overlay Canvas */}
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-12 items-start">
        {/* Left Column */}
        <div className="space-y-5 lg:col-span-5">
          <section className="rounded-xl border border-slate-200 bg-white p-4">
            <div className="mb-2.5 flex items-center justify-between gap-2">
              <h2 className="text-sm font-semibold text-slate-900">
                {isBn ? '১. জমির ছবি ও সীমানা শনাক্তকরণ' : '1. Source Photo & Plot Boundary'}
              </h2>
              <span className="font-mono text-xs text-slate-500 tabular-nums">
                {isAnalyzing
                  ? 'Analyzing...'
                  : analysis
                  ? `${analysis.ridgesNx.length} ridges · ${analysis.furrowsNx.length} furrows`
                  : 'Waiting'}
              </span>
            </div>

            <canvas
              ref={sourceCanvasRef}
              width={520}
              height={300}
              className="w-full rounded-lg bg-slate-950"
            />

            <p className="mt-2.5 text-xs text-slate-600">
              {isBn
                ? 'কোনো কোণা টানতে হবে না — Pi স্বয়ংক্রিয়ভাবে সীমানা খুঁজে ২ডি টপ-ডাউন BEV ছবি পাঠাবে।'
                : 'Zero manual corner dragging — automatic plot quadrilateral detection warps the perspective photo into a top-down BEV map.'}
            </p>
          </section>

          {/* Pi Hotspot Upload + Relay Mode + Mission Launch */}
          <section className="rounded-xl border border-slate-200 bg-white p-4 space-y-4">
            <div className="flex items-start justify-between gap-2">
              <div>
                <h2 className="text-sm font-semibold text-slate-900">
                  {isBn ? '৩. Pi সার্ভার সংযোগ ও মিশন লঞ্চ' : '3. Pi Server Sync & Launch'}
                </h2>
                <p className="mt-0.5 text-xs text-slate-500 font-mono">
                  POST /image → GET /bev_image → POST /start_mission
                </p>
              </div>
              <span
                className={`text-xs font-mono font-semibold whitespace-nowrap ${
                  bevSource === 'PI_SERVER' ? 'text-emerald-700' : 'text-slate-500'
                }`}
              >
                {bevSource === 'PI_SERVER' ? '● Pi BEV' : 'Local Preview'}
              </span>
            </div>

            <label className="block">
              <span className="mb-1 block text-xs font-medium text-slate-700">
                Raspberry Pi FastAPI Host
              </span>
              <input
                type="text"
                value={piHost}
                onChange={(e) => onPiHostChange(e.target.value)}
                placeholder="http://192.168.4.1:8000"
                className="w-full rounded-lg border border-slate-300 bg-slate-50 px-3 py-2 font-mono text-xs text-slate-900 focus:border-emerald-700 focus:bg-white focus:outline-none"
              />
            </label>

            <label className="block">
              <span className="mb-1 block text-xs font-medium text-slate-700">
                Pi API Security Token (Bearer, in-memory)
              </span>
              <input
                type="password"
                value={apiToken}
                onChange={(e) => onApiTokenChange(e.target.value)}
                placeholder="Optional WEED_ROVER_API_TOKEN"
                autoComplete="off"
                className="w-full rounded-lg border border-slate-300 bg-slate-50 px-3 py-2 font-mono text-xs text-slate-900 focus:border-emerald-700 focus:bg-white focus:outline-none"
              />
            </label>

            <button
              type="button"
              disabled={!sourceImage || isUploadingToPi || isAnalyzing}
              onClick={handleUploadToPi}
              className="flex w-full items-center justify-center gap-2 rounded-lg border border-slate-300 bg-white px-4 py-2.5 text-xs font-semibold text-slate-900 transition hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50"
            >
              <Send className="h-3.5 w-3.5" />
              {isUploadingToPi
                ? isBn
                  ? 'Pi-তে ছবি পাঠানো হচ্ছে...'
                  : 'Uploading Photo to Pi (/image)...'
                : isBn
                ? 'Pi-তে ছবি পাঠান ও সার্ভার BEV আনুন'
                : 'Upload Photo to Pi & Fetch Server BEV'}
            </button>

            <div>
              <span className="mb-1.5 block text-xs font-medium text-slate-700">
                ESP32 Dual Relay Board Mode
              </span>
              <div className="grid grid-cols-3 gap-1 rounded-lg bg-slate-100 p-1">
                {(
                  [
                    ['grinder', 'R1: Grinder'],
                    ['flame', 'R2: Flame'],
                    ['both', 'Dual Relay'],
                  ] as const
                ).map(([mode, label]) => (
                  <button
                    key={mode}
                    type="button"
                    onClick={() => setRelayMode(mode)}
                    className={`rounded-md px-2.5 py-1.5 text-xs font-semibold transition whitespace-nowrap ${
                      relayMode === mode
                        ? 'bg-white text-slate-900 shadow-xs'
                        : 'text-slate-600 hover:text-slate-900'
                    }`}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </div>

            <button
              type="button"
              disabled={!canLaunch}
              onClick={handleSendAndStart}
              className="flex w-full items-center justify-center gap-2 rounded-lg bg-emerald-700 px-4 py-3 text-sm font-semibold text-white transition hover:bg-emerald-800 disabled:cursor-not-allowed disabled:opacity-50"
            >
              <Play className="h-4 w-4" />
              {isLaunchingPi
                ? isBn
                  ? 'Pi-তে মিশন পাঠানো হচ্ছে...'
                  : 'Sending Mission JSON to Pi...'
                : bevSource === 'PI_SERVER'
                ? isBn
                  ? 'Pi-তে মিশন JSON পাঠান ও রোভার চালান'
                  : 'Send Mission JSON to Pi & Start Rover'
                : isBn
                ? 'মিশন JSON দিয়ে লাইভ সিমুলেটর চালান'
                : 'Launch Rover Preview with Mission JSON'}
            </button>

            {!canLaunch && (
              <p className="text-xs text-slate-500">
                {isBn
                  ? 'চালু করতে >=৪৫% আত্মবিশ্বাসে সারি শনাক্ত এবং BEV ছবিতে Start (S) বিন্দু ক্লিক করুন।'
                  : 'Requires >=45% furrow confidence and a clicked Start (S) point on the BEV image.'}
              </p>
            )}

            {sendStatus && <p className="text-xs font-medium text-emerald-700">{sendStatus}</p>}
          </section>
        </div>

        {/* Right Column (Focal Anchor): Clickable Pi BEV Image Container + Overlay Canvas + Live Pi Mission Plan JSON */}
        <section className="rounded-xl border border-slate-200 bg-white p-4 lg:col-span-7 space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h2 className="text-sm font-semibold text-slate-900">
                {isBn
                  ? '২. BEV ছবিতে ক্লিক করে Start (S) ও End (E) নির্বাচন করুন'
                  : '2. Click BEV Image to Place Start & End (0.0–1.0)'}
              </h2>
              <p className="text-xs text-slate-500 font-mono tabular-nums">
                {bevSource === 'PI_SERVER' ? 'Source: Pi Server /bev_image' : 'Source: Local BEV Preview'} ·{' '}
                {bevDims.width}×{bevDims.height} px
              </p>
            </div>

            <div className="flex flex-wrap items-center gap-1 rounded-lg bg-slate-100 p-1">
              <button
                type="button"
                onClick={() => setPointMode('START')}
                className={`inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-semibold transition whitespace-nowrap shrink-0 ${
                  pointMode === 'START'
                    ? 'bg-emerald-700 text-white'
                    : 'text-slate-700 hover:bg-white/70'
                }`}
              >
                <Crosshair className="h-3.5 w-3.5" />
                Set Start (S)
              </button>
              <button
                type="button"
                onClick={() => setPointMode('END')}
                className={`inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-semibold transition whitespace-nowrap shrink-0 ${
                  pointMode === 'END'
                    ? 'bg-red-600 text-white'
                    : 'text-slate-700 hover:bg-white/70'
                }`}
              >
                <Crosshair className="h-3.5 w-3.5" />
                Set End (E)
              </button>
              {endPoint && (
                <button
                  type="button"
                  onClick={() => setEndPoint(null)}
                  title="Clear End point"
                  className="inline-flex items-center gap-1 rounded-md px-2 py-1.5 text-xs font-medium text-slate-600 hover:bg-white hover:text-slate-900 whitespace-nowrap shrink-0"
                >
                  <X className="h-3.5 w-3.5" />
                  Clear E
                </button>
              )}
              <button
                type="button"
                disabled={!analysis || analysis.furrowsNx.length === 0}
                onClick={() => {
                  if (!analysis || analysis.furrowsNx.length === 0) return;
                  const first = analysis.furrowsNx[0];
                  const last = analysis.furrowsNx[analysis.furrowsNx.length - 1];
                  setStartPoint({ nx: Number(first.toFixed(4)), ny: 0.89 });
                  setEndPoint({ nx: Number(last.toFixed(4)), ny: 0.11 });
                  setPointMode('START');
                }}
                title="Auto-place Start at Furrow 1 and End at last furrow"
                className="inline-flex items-center gap-1 rounded-md px-2 py-1.5 text-xs font-medium text-slate-700 hover:bg-white hover:text-slate-900 disabled:opacity-40 whitespace-nowrap shrink-0"
              >
                <RotateCcw className="h-3.5 w-3.5" />
                {isBn ? 'F1→শেষ' : 'Auto F1→End'}
              </button>
            </div>
          </div>

          {/* Clickable BEV Image Container: onClick stores Start/End as 0.0–1.0 percentages relative to container dimensions */}
          <div
            role="button"
            tabIndex={0}
            aria-label="BEV field image container — click to place Start and End coordinates"
            onClick={handleImageContainerClick}
            onMouseMove={handleImageContainerMouseMove}
            onMouseLeave={() => setHoverPoint(null)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                const fallback: NormalizedPoint = { nx: 0.5, ny: pointMode === 'START' ? 0.88 : 0.12 };
                if (pointMode === 'START') {
                  setStartPoint(fallback);
                  setPointMode('END');
                } else {
                  setEndPoint(fallback);
                  setPointMode('START');
                }
              }
            }}
            className="relative w-full cursor-crosshair overflow-hidden rounded-lg bg-slate-950 select-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-700"
            style={{ aspectRatio: `${bevDims.width} / ${bevDims.height}` }}
          >
            {bevImageUrl && !bevImgError ? (
              <img
                src={bevImageUrl}
                alt="Auto-warped 2D top-down BEV field map from Raspberry Pi"
                referrerPolicy="no-referrer"
                onLoad={handleBevImgLoad}
                onError={() =>
                  setBevImgError(
                    'Failed to load BEV image from Pi server. Verify Pi hotspot connection and CORS/network reachability.'
                  )
                }
                className="block h-full w-full object-fill pointer-events-none select-none"
              />
            ) : (
              <div className="flex h-full w-full items-center justify-center p-6 text-center text-xs text-slate-300 pointer-events-none">
                {bevImgError ?? (isAnalyzing ? 'Generating top-down BEV image...' : 'Waiting for BEV image')}
              </div>
            )}

            <canvas
              ref={overlayCanvasRef}
              width={bevDims.width}
              height={bevDims.height}
              className="pointer-events-none absolute inset-0 h-full w-full"
            />
          </div>

          {/* Clean Unboxed Coordinate & Route Metadata Strip */}
          <div className="flex flex-wrap items-center justify-between gap-2 border-t border-slate-100 pt-3 text-xs text-slate-600">
            <div className="flex flex-wrap items-center gap-3 font-mono tabular-nums">
              <span>
                Conf:{' '}
                <strong className={analysis?.ready ? 'text-emerald-700' : 'text-red-700'}>
                  {analysis ? `${Math.round(analysis.confidence * 100)}%` : '—'}
                </strong>
              </span>
              <span aria-hidden="true">·</span>
              <span>
                Start:{' '}
                <strong className={startPoint ? 'text-emerald-700' : 'text-slate-400'}>
                  {startPoint && startPixel
                    ? `(${startPoint.nx.toFixed(3)}, ${startPoint.ny.toFixed(3)}) [${startPixel.x},${startPixel.y}px]`
                    : 'Click BEV image'}
                </strong>
              </span>
              <span aria-hidden="true">·</span>
              <span>
                End:{' '}
                <strong className={endPoint ? 'text-red-700' : 'text-slate-400'}>
                  {endPoint && endPixel
                    ? `(${endPoint.nx.toFixed(3)}, ${endPoint.ny.toFixed(3)}) [${endPixel.x},${endPixel.y}px]`
                    : 'Optional'}
                </strong>
              </span>
              <span aria-hidden="true">·</span>
              <span>
                Route:{' '}
                <strong className="text-slate-900">
                  {coveredFurrows} furrows / {routeWaypoints.length} wps
                </strong>
              </span>
            </div>

            <div className="flex flex-wrap items-center gap-3 text-xs text-slate-500">
              <span>Green: Ridges</span>
              <span aria-hidden="true">/</span>
              <span>Amber: Furrows &amp; U-Turns</span>
              <span aria-hidden="true">/</span>
              <span>Cyan: Route</span>
            </div>
          </div>

          {/* Translated Pi Mission Plan JSON Preview (POST /start_mission payload) */}
          <div className="border-t border-slate-200 pt-3">
            <div className="mb-2 flex items-center justify-between gap-2">
              <div className="text-xs font-semibold text-slate-900">
                Pi Mission Plan JSON{' '}
                <span className="font-mono font-normal text-slate-500">(POST /start_mission)</span>
              </div>
              <button
                type="button"
                disabled={!missionPlanJsonString}
                onClick={handleCopyMissionJson}
                className="inline-flex items-center gap-1.5 rounded-md border border-slate-300 bg-white px-2.5 py-1 text-xs font-semibold text-slate-700 transition hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-40 whitespace-nowrap shrink-0"
              >
                {copiedJson ? <Check className="h-3.5 w-3.5 text-emerald-700" /> : <Copy className="h-3.5 w-3.5" />}
                {copiedJson ? 'Copied' : 'Copy JSON'}
              </button>
            </div>

            {missionPlanJsonString ? (
              <pre className="overflow-x-auto rounded-lg bg-slate-950 p-3 font-mono text-xs leading-relaxed text-slate-100 tabular-nums">
                {missionPlanJsonString}
              </pre>
            ) : (
              <p className="rounded-lg border border-dashed border-slate-200 bg-slate-50 px-3 py-2.5 font-mono text-xs text-slate-500">
                Click on the BEV image container above to store Start (0.0–1.0) and generate the Pi mission JSON.
              </p>
            )}
          </div>
        </section>
      </div>
    </div>
  );
};
