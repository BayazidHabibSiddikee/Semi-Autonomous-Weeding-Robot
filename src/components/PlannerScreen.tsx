import React, { useEffect, useRef, useState } from 'react';
import {
  Upload,
  RotateCcw,
  Copy,
  Download,
  Send,
  Sparkles,
  CheckCircle2,
  AlertCircle,
  Image as ImageIcon,
  Play,
} from 'lucide-react';
import { AppLanguage, Strings } from '../i18n/strings';
import {
  BevOutcome,
  Field,
  FieldCorners,
  Mission,
  areCornersValidForImage,
  cornersToList,
  fieldToPixel,
  missionTotalDistanceM,
} from '../domain/models';
import { detectRowsFromImageData, warpToBEV } from '../domain/bevPipeline';
import { generateBoustrophedonMission } from '../domain/boustrophedon';

interface Props {
  lang: AppLanguage;
  onSimulateMission: (mission: Mission) => void;
}

const CORNER_LABELS = ['TL', 'TR', 'BR', 'BL'] as const;
const FIELD_STORAGE_KEY = 'weed_rover_field_config_v1';
const MIN_ROW_CONFIDENCE = 0.45;
const MIN_DETECTED_ROWS = 2;

const DEFAULT_FIELD: Field = {
  widthM: 6.0,
  lengthM: 8.0,
  totalRows: 10,
  rowSpacingM: 0.6,
  originCorner: 'TOP_LEFT',
};

function loadPersistedField(): Field {
  try {
    const raw = window.localStorage.getItem(FIELD_STORAGE_KEY);
    if (!raw) return DEFAULT_FIELD;
    const parsed = JSON.parse(raw) as Partial<Field>;
    if (
      typeof parsed.widthM === 'number' &&
      parsed.widthM > 0 &&
      typeof parsed.lengthM === 'number' &&
      parsed.lengthM > 0 &&
      typeof parsed.totalRows === 'number' &&
      parsed.totalRows > 0 &&
      typeof parsed.rowSpacingM === 'number' &&
      parsed.rowSpacingM > 0
    ) {
      return {
        widthM: parsed.widthM,
        lengthM: parsed.lengthM,
        totalRows: Math.round(parsed.totalRows),
        rowSpacingM: parsed.rowSpacingM,
        originCorner: parsed.originCorner ?? 'TOP_LEFT',
      };
    }
  } catch {
    // ignore storage errors
  }
  return DEFAULT_FIELD;
}

function defaultCorners(w: number, h: number): FieldCorners {
  return {
    topLeft: { x: w * 0.12, y: h * 0.14 },
    topRight: { x: w * 0.88, y: h * 0.14 },
    bottomRight: { x: w * 0.92, y: h * 0.88 },
    bottomLeft: { x: w * 0.08, y: h * 0.88 },
  };
}

function fitRect(containerW: number, containerH: number, imgW: number, imgH: number) {
  const aspect = imgW / imgH;
  let drawW = containerW;
  let drawH = containerH;
  if (drawW / drawH > aspect) {
    drawW = drawH * aspect;
  } else {
    drawH = drawW / aspect;
  }
  return {
    drawW,
    drawH,
    dx: (containerW - drawW) / 2,
    dy: (containerH - drawH) / 2,
  };
}

export const PlannerScreen: React.FC<Props> = ({ lang, onSimulateMission }) => {
  const [imageUrl, setImageUrl] = useState<string | null>('/media/field_render.png');
  const [loadedImage, setLoadedImage] = useState<HTMLImageElement | null>(null);
  const [corners, setCorners] = useState<FieldCorners | null>(null);
  const [draggedIdx, setDraggedIdx] = useState<number | null>(null);

  const [field, setField] = useState<Field>(() => loadPersistedField());
  const [widthText, setWidthText] = useState(() => String(field.widthM));
  const [lengthText, setLengthText] = useState(() => String(field.lengthM));
  const [rowsText, setRowsText] = useState(() => String(field.totalRows));
  const [spacingText, setSpacingText] = useState(() => String(field.rowSpacingM));

  const [piIp, setPiIp] = useState('192.168.4.1');
  const [piPort, setPiPort] = useState('8080');
  const [isProcessing, setIsProcessing] = useState(false);
  const [outcome, setOutcome] = useState<BevOutcome>({ status: 'idle' });
  const [transferNotice, setTransferNotice] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);

  const cornerCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const bevCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  // Persist field configuration across reloads (mirrors SharedPreferencesFieldRepository)
  useEffect(() => {
    try {
      window.localStorage.setItem(FIELD_STORAGE_KEY, JSON.stringify(field));
    } catch {
      // ignore quota/private mode errors
    }
  }, [field]);

  // Load image whenever imageUrl changes
  useEffect(() => {
    if (!imageUrl) {
      setLoadedImage(null);
      setCorners(null);
      return;
    }
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => {
      setLoadedImage(img);
      setCorners(defaultCorners(img.naturalWidth, img.naturalHeight));
      setOutcome({ status: 'idle' });
      setTransferNotice(null);
    };
    img.onerror = () => {
      setLoadedImage(null);
    };
    img.src = imageUrl;
  }, [imageUrl]);

  // Draw corner selection canvas
  useEffect(() => {
    const canvas = cornerCanvasRef.current;
    if (!canvas || !loadedImage || !corners) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const w = canvas.width;
    const h = canvas.height;
    const imgW = loadedImage.naturalWidth;
    const imgH = loadedImage.naturalHeight;

    ctx.fillStyle = '#111611';
    ctx.fillRect(0, 0, w, h);

    const { drawW, drawH, dx, dy } = fitRect(w, h, imgW, imgH);
    ctx.drawImage(loadedImage, dx, dy, drawW, drawH);

    const pts = cornersToList(corners).map((p) => ({
      x: (p.x / imgW) * drawW + dx,
      y: (p.y / imgH) * drawH + dy,
    }));

    const cornersOk = areCornersValidForImage(corners, imgW, imgH);

    // Polygon fill & stroke (red warning if twisted/counter-clockwise/too small)
    ctx.beginPath();
    ctx.moveTo(pts[0].x, pts[0].y);
    pts.slice(1).forEach((p) => ctx.lineTo(p.x, p.y));
    ctx.closePath();
    ctx.fillStyle = cornersOk ? 'rgba(0, 229, 255, 0.14)' : 'rgba(255, 82, 82, 0.22)';
    ctx.fill();
    ctx.strokeStyle = cornersOk ? '#00E5FF' : '#FF5252';
    ctx.lineWidth = 3;
    ctx.stroke();

    // Corner handles & labels
    pts.forEach((p, idx) => {
      const isDragged = draggedIdx === idx;
      if (isDragged) {
        ctx.beginPath();
        ctx.arc(p.x, p.y, 28, 0, Math.PI * 2);
        ctx.fillStyle = 'rgba(255, 235, 59, 0.32)';
        ctx.fill();
      }
      ctx.beginPath();
      ctx.arc(p.x, p.y, isDragged ? 16 : 13, 0, Math.PI * 2);
      ctx.strokeStyle = isDragged ? '#FFEB3B' : cornersOk ? '#00E5FF' : '#FF5252';
      ctx.lineWidth = 3.5;
      ctx.stroke();

      ctx.beginPath();
      ctx.arc(p.x, p.y, isDragged ? 6 : 5, 0, Math.PI * 2);
      ctx.fillStyle = '#FFFFFF';
      ctx.fill();

      const label = CORNER_LABELS[idx];
      ctx.font = 'bold 12px sans-serif';
      const tw = ctx.measureText(label).width;
      const bw = tw + 12;
      const bh = 20;
      const bx = Math.max(4, Math.min(w - bw - 4, p.x - bw / 2));
      const by = Math.max(4, Math.min(h - bh - 4, p.y - 34));
      ctx.fillStyle = isDragged ? '#FFEB3B' : cornersOk ? 'rgba(0, 229, 255, 0.9)' : '#FF5252';
      ctx.beginPath();
      ctx.roundRect(bx, by, bw, bh, 5);
      ctx.fill();
      ctx.fillStyle = cornersOk || isDragged ? '#000000' : '#FFFFFF';
      ctx.fillText(label, bx + 6, by + 14);
    });
  }, [loadedImage, corners, draggedIdx]);

  // Draw BEV & Boustrophedon path overlay
  useEffect(() => {
    if (outcome.status !== 'success') return;
    const canvas = bevCanvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const img = new Image();
    img.onload = () => {
      const w = canvas.width;
      const h = canvas.height;
      ctx.fillStyle = '#0D120D';
      ctx.fillRect(0, 0, w, h);

      const { drawW, drawH, dx, dy } = fitRect(w, h, img.width, img.height);
      ctx.drawImage(img, dx, dy, drawW, drawH);

      // Detected crop row centers (yellow vertical lines)
      ctx.strokeStyle = 'rgba(255, 235, 59, 0.75)';
      ctx.lineWidth = 2;
      ctx.setLineDash([6, 4]);
      outcome.rows.rowCentersX.forEach((rowX) => {
        const cx = (rowX / img.width) * drawW + dx;
        ctx.beginPath();
        ctx.moveTo(cx, dy);
        ctx.lineTo(cx, dy + drawH);
        ctx.stroke();
      });
      ctx.setLineDash([]);

      // Boustrophedon path segments
      outcome.mission.path.forEach((seg) => {
        const sPx = fieldToPixel(outcome.calibration, seg.startPoint);
        const ePx = fieldToPixel(outcome.calibration, seg.endPoint);
        const sx = (sPx.x / img.width) * drawW + dx;
        const sy = (sPx.y / img.height) * drawH + dy;
        const ex = (ePx.x / img.width) * drawW + dx;
        const ey = (ePx.y / img.height) * drawH + dy;

        if (seg.type === 'FollowRow') {
          ctx.strokeStyle = '#00E676';
          ctx.lineWidth = 3;
          ctx.beginPath();
          ctx.moveTo(sx, sy);
          ctx.lineTo(ex, ey);
          ctx.stroke();

          ctx.fillStyle = '#00E5FF';
          ctx.beginPath();
          ctx.arc(sx, sy, 4.5, 0, Math.PI * 2);
          ctx.fill();
        } else {
          ctx.strokeStyle = '#E040FB';
          ctx.lineWidth = 3;
          ctx.beginPath();
          ctx.moveTo(sx, sy);
          ctx.lineTo(ex, ey);
          ctx.stroke();
        }
      });
    };
    img.src = outcome.bevDataUrl;
  }, [outcome]);

  const getPointerCanvasCoords = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const canvas = cornerCanvasRef.current!;
    const rect = canvas.getBoundingClientRect();
    return {
      cx: ((e.clientX - rect.left) / rect.width) * canvas.width,
      cy: ((e.clientY - rect.top) / rect.height) * canvas.height,
    };
  };

  const handlePointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!loadedImage || !corners || !cornerCanvasRef.current) return;
    const { cx, cy } = getPointerCanvasCoords(e);
    const canvas = cornerCanvasRef.current;
    const { drawW, drawH, dx, dy } = fitRect(
      canvas.width,
      canvas.height,
      loadedImage.naturalWidth,
      loadedImage.naturalHeight
    );
    const pts = cornersToList(corners);
    let bestIdx = -1;
    let bestDist = 48;
    pts.forEach((p, idx) => {
      const sx = (p.x / loadedImage.naturalWidth) * drawW + dx;
      const sy = (p.y / loadedImage.naturalHeight) * drawH + dy;
      const dist = Math.hypot(cx - sx, cy - sy);
      if (dist < bestDist) {
        bestDist = dist;
        bestIdx = idx;
      }
    });
    if (bestIdx !== -1) {
      setDraggedIdx(bestIdx);
      e.currentTarget.setPointerCapture(e.pointerId);
    }
  };

  const handlePointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (draggedIdx === null || !loadedImage || !corners || !cornerCanvasRef.current) return;
    const { cx, cy } = getPointerCanvasCoords(e);
    const canvas = cornerCanvasRef.current;
    const imgW = loadedImage.naturalWidth;
    const imgH = loadedImage.naturalHeight;
    const { drawW, drawH, dx, dy } = fitRect(canvas.width, canvas.height, imgW, imgH);

    const imgX = Math.max(0, Math.min(imgW, ((cx - dx) / drawW) * imgW));
    const imgY = Math.max(0, Math.min(imgH, ((cy - dy) / drawH) * imgH));

    const list = cornersToList(corners);
    list[draggedIdx] = { x: imgX, y: imgY };
    setCorners({
      topLeft: list[0],
      topRight: list[1],
      bottomRight: list[2],
      bottomLeft: list[3],
    });
  };

  const handlePointerUp = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (draggedIdx !== null) {
      setDraggedIdx(null);
      if (e.currentTarget.hasPointerCapture(e.pointerId)) {
        e.currentTarget.releasePointerCapture(e.pointerId);
      }
    }
  };

  const handleFileSelected = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === 'string') {
        setImageUrl(reader.result);
      }
    };
    reader.readAsDataURL(file);
  };

  const handleGenerate = () => {
    if (!loadedImage || !corners) return;
    const imgW = loadedImage.naturalWidth;
    const imgH = loadedImage.naturalHeight;
    if (!areCornersValidForImage(corners, imgW, imgH)) {
      setOutcome({
        status: 'error',
        message:
          lang === 'BN'
            ? 'নির্বাচিত চার কোণা অবশ্যই ঘড়ির কাঁটার দিকে (TL → TR → BR → BL) উত্তল ও ছবির ভেতরে থাকতে হবে (ন্যূনতম ২% ক্ষেত্রফল)।'
            : 'Selected corners must form a clockwise convex quadrilateral (TL → TR → BR → BL) inside the image covering at least 2% area.',
      });
      return;
    }

    setIsProcessing(true);
    setTransferNotice(null);
    setTimeout(() => {
      try {
        const targetW = 600;
        const targetH = Math.max(
          320,
          Math.min(900, Math.round((targetW * field.lengthM) / Math.max(0.5, field.widthM)))
        );
        const { bevDataUrl, bevImageData, calibration } = warpToBEV(
          loadedImage,
          corners,
          targetW,
          targetH,
          field.widthM,
          field.lengthM
        );
        const rows = detectRowsFromImageData(bevImageData, field.totalRows);

        // Honest confidence gate (matches BeViewModel.kt MIN_ROW_CONFIDENCE = 0.45f)
        if (rows.detectedRowCount < MIN_DETECTED_ROWS || rows.confidence < MIN_ROW_CONFIDENCE) {
          setOutcome({
            status: 'error',
            message:
              lang === 'BN'
                ? `পর্যাপ্ত ফসলের সারি শনাক্ত হয়নি (${rows.detectedRowCount}টি সারি, আত্মবিশ্বাস ${Math.round(rows.confidence * 100)}%)। দয়া করে সবুজ ফসলের সারির ছবি দিন ও কোণাগুলো ঠিকমতো বসান।`
                : `Crop row detection confidence too low (${rows.detectedRowCount} rows detected, ${Math.round(rows.confidence * 100)}% confidence — minimum 45% & 2 rows required). Adjust the 4 corners over green crop rows or capture a clearer field photo.`,
          });
          return;
        }

        const mission = generateBoustrophedonMission(field, rows, calibration);
        setOutcome({
          status: 'success',
          bevDataUrl,
          calibration,
          rows,
          mission,
        });
      } catch (err) {
        setOutcome({
          status: 'error',
          message: err instanceof Error ? err.message : 'Failed to generate BEV mission',
        });
      } finally {
        setIsProcessing(false);
      }
    }, 20);
  };

  const handleCopyJson = async () => {
    if (outcome.status !== 'success') return;
    const jsonStr = JSON.stringify(outcome.mission, null, 2);
    try {
      await navigator.clipboard.writeText(jsonStr);
      setTransferNotice({ kind: 'ok', text: Strings.jsonCopied(lang) });
    } catch {
      setTransferNotice({ kind: 'err', text: 'Clipboard permission denied' });
    }
  };

  const handleDownloadJson = () => {
    if (outcome.status !== 'success') return;
    const blob = new Blob([JSON.stringify(outcome.mission, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `weed_rover_mission_${field.totalRows}rows.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const handleSendToPi = () => {
    if (outcome.status !== 'success') return;
    setTransferNotice({
      kind: 'ok',
      text:
        lang === 'BN'
          ? `মিশন পেলোড (http://${piIp}:${piPort}/mission) প্রস্তুত — Pi-তে Navigation/src/mission_receiver.py চালিয়ে Android অ্যাপ থেকে সরাসরি পাঠান বা JSON ডাউনলোড করুন।`
          : `Mission payload ready for http://${piIp}:${piPort}/mission (run python3 Navigation/src/mission_receiver.py on the Raspberry Pi and send from the Android app, or export JSON here).`,
    });
  };

  return (
    <div className="space-y-4">
      {/* Step 1: Field Photo & 4 Corners */}
      <section className="rounded-2xl border border-[#DCE5D7] bg-white p-4 shadow-xs">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-base font-bold text-[#1C1D1A]">{Strings.step1Title(lang)}</h2>
          <div className="flex flex-wrap gap-2">
            <input
              ref={fileInputRef}
              type="file"
              accept="image/*"
              onChange={handleFileSelected}
              className="hidden"
            />
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              className="inline-flex items-center gap-1.5 rounded-lg border border-[#2E7D32] px-3 py-1.5 text-xs font-semibold text-[#2E7D32] transition hover:bg-[#2E7D32]/10"
            >
              <Upload className="h-3.5 w-3.5" />
              {Strings.pickPhoto(lang, !!imageUrl)}
            </button>
            <button
              type="button"
              onClick={() => setImageUrl('/media/field_render.png')}
              className="inline-flex items-center gap-1.5 rounded-lg border border-[#C6D3C1] px-3 py-1.5 text-xs font-medium text-[#43483F] transition hover:bg-[#E2E7DD]/60"
            >
              <ImageIcon className="h-3.5 w-3.5" />
              {Strings.useSamplePhoto(lang)}
            </button>
            {loadedImage && (
              <button
                type="button"
                onClick={() =>
                  setCorners(defaultCorners(loadedImage.naturalWidth, loadedImage.naturalHeight))
                }
                className="inline-flex items-center gap-1 rounded-lg px-2.5 py-1.5 text-xs font-medium text-[#2E7D32] hover:bg-[#2E7D32]/10"
              >
                <RotateCcw className="h-3.5 w-3.5" />
                {lang === 'BN' ? 'রিসেট' : 'Reset'}
              </button>
            )}
          </div>
        </div>

        {loadedImage ? (
          <div>
            <canvas
              ref={cornerCanvasRef}
              width={860}
              height={420}
              onPointerDown={handlePointerDown}
              onPointerMove={handlePointerMove}
              onPointerUp={handlePointerUp}
              onPointerCancel={handlePointerUp}
              className="h-[300px] w-full cursor-crosshair touch-none rounded-xl bg-[#111611] sm:h-[360px]"
            />
            <p className="mt-2 text-xs font-medium text-[#2E7D32]">{Strings.dragHandleHint(lang)}</p>
          </div>
        ) : (
          <div className="rounded-xl border border-dashed border-[#C6D3C1] bg-[#F9FBF7] p-8 text-center text-sm text-[#43483F]">
            {Strings.noPhotoSelected(lang)}
          </div>
        )}
      </section>

      {/* Step 2: Field Dimensions */}
      <section className="rounded-2xl border border-[#DCE5D7] bg-white p-4 shadow-xs">
        <h2 className="mb-3 text-base font-bold text-[#1C1D1A]">{Strings.step2Title(lang)}</h2>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <label className="block">
            <span className="mb-1 block text-xs font-semibold text-[#43483F]">
              {Strings.widthLabel(lang)}
            </span>
            <input
              type="text"
              inputMode="decimal"
              value={widthText}
              onChange={(e) => {
                setWidthText(e.target.value);
                const v = parseFloat(e.target.value);
                if (!Number.isNaN(v) && v > 0) setField((f) => ({ ...f, widthM: v }));
              }}
              className="w-full rounded-lg border border-[#C6D3C1] bg-[#F9FBF7] px-3 py-2 text-sm font-medium focus:border-[#2E7D32] focus:outline-none"
            />
          </label>
          <label className="block">
            <span className="mb-1 block text-xs font-semibold text-[#43483F]">
              {Strings.lengthLabel(lang)}
            </span>
            <input
              type="text"
              inputMode="decimal"
              value={lengthText}
              onChange={(e) => {
                setLengthText(e.target.value);
                const v = parseFloat(e.target.value);
                if (!Number.isNaN(v) && v > 0) setField((f) => ({ ...f, lengthM: v }));
              }}
              className="w-full rounded-lg border border-[#C6D3C1] bg-[#F9FBF7] px-3 py-2 text-sm font-medium focus:border-[#2E7D32] focus:outline-none"
            />
          </label>
          <label className="block">
            <span className="mb-1 block text-xs font-semibold text-[#43483F]">
              {Strings.totalRowsLabel(lang)}
            </span>
            <input
              type="text"
              inputMode="numeric"
              value={rowsText}
              onChange={(e) => {
                setRowsText(e.target.value);
                const v = parseInt(e.target.value, 10);
                if (!Number.isNaN(v) && v > 0) setField((f) => ({ ...f, totalRows: v }));
              }}
              className="w-full rounded-lg border border-[#C6D3C1] bg-[#F9FBF7] px-3 py-2 text-sm font-medium focus:border-[#2E7D32] focus:outline-none"
            />
          </label>
          <label className="block">
            <span className="mb-1 block text-xs font-semibold text-[#43483F]">
              {Strings.rowSpacingLabel(lang)}
            </span>
            <input
              type="text"
              inputMode="decimal"
              value={spacingText}
              onChange={(e) => {
                setSpacingText(e.target.value);
                const v = parseFloat(e.target.value);
                if (!Number.isNaN(v) && v > 0) setField((f) => ({ ...f, rowSpacingM: v }));
              }}
              className="w-full rounded-lg border border-[#C6D3C1] bg-[#F9FBF7] px-3 py-2 text-sm font-medium focus:border-[#2E7D32] focus:outline-none"
            />
          </label>
        </div>
      </section>

      {/* Step 3: Generate Action */}
      <button
        type="button"
        disabled={!loadedImage || !corners || isProcessing}
        onClick={handleGenerate}
        className="flex w-full items-center justify-center gap-2 rounded-xl bg-[#2E7D32] px-4 py-3 text-sm font-bold text-white shadow-sm transition hover:bg-[#1B5E20] disabled:cursor-not-allowed disabled:opacity-50"
      >
        <Sparkles className="h-4 w-4" />
        {Strings.generateMission(lang, isProcessing)}
      </button>

      {/* Outcome Panel */}
      {outcome.status === 'idle' && (
        <p className="text-center text-sm text-[#43483F]">{Strings.idleHint(lang)}</p>
      )}

      {outcome.status === 'error' && (
        <div className="flex items-center justify-between gap-3 rounded-xl border border-red-300 bg-red-50 p-4 text-sm text-red-900">
          <div className="flex items-center gap-2">
            <AlertCircle className="h-4 w-4 shrink-0 text-red-600" />
            <span>{outcome.message}</span>
          </div>
          <button
            type="button"
            onClick={() => setOutcome({ status: 'idle' })}
            className="shrink-0 text-xs font-bold underline"
          >
            {Strings.retry(lang)}
          </button>
        </div>
      )}

      {outcome.status === 'success' && (
        <section className="space-y-3 rounded-2xl border border-[#81C784] bg-[#E8F5E9] p-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <CheckCircle2 className="h-5 w-5 text-[#1B5E20]" />
              <h3 className="text-base font-bold text-[#1B5E20]">{Strings.missionReady(lang)}</h3>
            </div>
            <div className="text-xs font-semibold text-[#1B5E20]">
              {outcome.rows.detectedRowCount} detected → {outcome.mission.field.totalRows} rows ·{' '}
              {outcome.mission.field.lengthM}m × {outcome.mission.field.widthM}m · ≈
              {missionTotalDistanceM(outcome.mission).toFixed(1)}m total · Confidence{' '}
              {Math.round(outcome.rows.confidence * 100)}%
            </div>
          </div>

          <canvas
            ref={bevCanvasRef}
            width={800}
            height={380}
            className="h-[260px] w-full rounded-xl bg-[#0D120D] sm:h-[340px]"
          />

          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex flex-wrap items-center gap-4 text-xs text-[#1B5E20]">
              <span className="inline-flex items-center gap-1.5">
                <span className="h-2.5 w-2.5 rounded-full bg-[#FFEB3B]" /> Detected Crop Rows
              </span>
              <span className="inline-flex items-center gap-1.5">
                <span className="h-2.5 w-2.5 rounded-full bg-[#00E676]" /> Follow Row Path
              </span>
              <span className="inline-flex items-center gap-1.5">
                <span className="h-2.5 w-2.5 rounded-full bg-[#E040FB]" /> Headland Turn
              </span>
              <span className="inline-flex items-center gap-1.5">
                <span className="h-2.5 w-2.5 rounded-full bg-[#00E5FF]" /> Row Start Waypoint
              </span>
            </div>

            <button
              type="button"
              onClick={() => onSimulateMission(outcome.mission)}
              className="inline-flex items-center gap-1.5 rounded-lg bg-[#1B5E20] px-3.5 py-2 text-xs font-bold text-white shadow-xs transition hover:bg-[#144718]"
            >
              <Play className="h-3.5 w-3.5" />
              {Strings.simulateMission(lang)}
            </button>
          </div>

          <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
            <input
              type="text"
              value={piIp}
              onChange={(e) => setPiIp(e.target.value)}
              placeholder="Raspberry Pi IP"
              className="rounded-lg border border-[#81C784] bg-white px-3 py-2 text-xs font-medium sm:col-span-2"
            />
            <input
              type="text"
              value={piPort}
              onChange={(e) => setPiPort(e.target.value)}
              placeholder="Port"
              className="rounded-lg border border-[#81C784] bg-white px-3 py-2 text-xs font-medium"
            />
          </div>

          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              onClick={handleSendToPi}
              className="inline-flex flex-1 items-center justify-center gap-1.5 rounded-lg bg-[#2E7D32] px-3 py-2 text-xs font-bold text-white hover:bg-[#1B5E20]"
            >
              <Send className="h-3.5 w-3.5" />
              {Strings.sendToPi(lang, piIp)}
            </button>
            <button
              type="button"
              onClick={handleCopyJson}
              className="inline-flex items-center justify-center gap-1.5 rounded-lg border border-[#2E7D32] bg-white px-3 py-2 text-xs font-bold text-[#1B5E20] hover:bg-[#2E7D32]/10"
            >
              <Copy className="h-3.5 w-3.5" />
              {Strings.copyJson(lang)}
            </button>
            <button
              type="button"
              onClick={handleDownloadJson}
              className="inline-flex items-center justify-center gap-1.5 rounded-lg border border-[#2E7D32] bg-white px-3 py-2 text-xs font-bold text-[#1B5E20] hover:bg-[#2E7D32]/10"
            >
              <Download className="h-3.5 w-3.5" />
              {Strings.downloadJson(lang)}
            </button>
          </div>

          {transferNotice && (
            <p
              className={`rounded-lg px-3 py-2 text-xs font-medium ${
                transferNotice.kind === 'ok'
                  ? 'bg-white/80 text-[#1B5E20]'
                  : 'bg-red-100 text-red-800'
              }`}
            >
              {transferNotice.text}
            </p>
          )}
        </section>
      )}
    </div>
  );
};
