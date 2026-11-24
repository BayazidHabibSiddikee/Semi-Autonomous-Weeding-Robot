import React, { useEffect, useRef, useState } from 'react';
import { RotateCcw } from 'lucide-react';
import { AppLanguage } from '../i18n/strings';

interface Props {
  lang: AppLanguage;
}

interface ChassisMesh {
  vertices: Float32Array;
  edges: Int32Array;
  numTriangles: number;
}

export const Chassis3DViewer: React.FC<Props> = ({ lang }) => {
  const isBn = lang === 'BN';
  const [mesh, setMesh] = useState<ChassisMesh | null>(null);
  const [loading, setLoading] = useState(true);
  const [rotX, setRotX] = useState(25);
  const [rotY, setRotY] = useState(45);
  const [zoom, setZoom] = useState(1.0);

  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const dragRef = useRef<{ x: number; y: number } | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch('/assets/chassis.bin')
      .then((res) => {
        if (!res.ok) throw new Error('Failed to load chassis.bin');
        return res.arrayBuffer();
      })
      .then((buf) => {
        if (cancelled) return;
        const view = new DataView(buf);
        const numVertices = view.getInt32(0, true);
        const numIndices = view.getInt32(4, true);

        const vertices = new Float32Array(numVertices * 3);
        let offset = 8;
        for (let i = 0; i < numVertices * 3; i++) {
          vertices[i] = view.getFloat32(offset, true);
          offset += 4;
        }

        const rawIndices = new Int32Array(numIndices);
        for (let i = 0; i < numIndices; i++) {
          rawIndices[i] = view.getInt32(offset, true);
          offset += 4;
        }

        const edgeList: number[] = [];
        for (let i = 0; i < numIndices - 2; i += 3) {
          const i0 = rawIndices[i];
          const i1 = rawIndices[i + 1];
          const i2 = rawIndices[i + 2];
          if (i0 >= 0 && i0 < numVertices && i1 >= 0 && i1 < numVertices && i2 >= 0 && i2 < numVertices) {
            edgeList.push(i0, i1, i1, i2, i2, i0);
          }
        }

        setMesh({
          vertices,
          edges: new Int32Array(edgeList),
          numTriangles: Math.floor(numIndices / 3),
        });
      })
      .catch(() => {
        if (!cancelled) setMesh(null);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !mesh) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const w = canvas.width;
    const h = canvas.height;
    const cx = w / 2;
    const cy = h / 2;
    const baseScale = Math.min(w, h) * 0.42 * zoom;

    ctx.fillStyle = '#1E281E';
    ctx.fillRect(0, 0, w, h);

    // Reference floor grid
    const gridRadius = baseScale * 1.2;
    ctx.strokeStyle = 'rgba(129, 199, 132, 0.16)';
    ctx.lineWidth = 1;
    for (let g = -3; g <= 3; g++) {
      const off = g * (gridRadius / 3);
      ctx.beginPath();
      ctx.moveTo(cx - gridRadius, cy + baseScale * 0.8 + off * 0.3);
      ctx.lineTo(cx + gridRadius, cy + baseScale * 0.8 + off * 0.3);
      ctx.stroke();
    }

    const radX = (rotX * Math.PI) / 180;
    const radY = (rotY * Math.PI) / 180;
    const cosX = Math.cos(radX);
    const sinX = Math.sin(radX);
    const cosY = Math.cos(radY);
    const sinY = Math.sin(radY);

    const numV = mesh.vertices.length / 3;
    const projX = new Float32Array(numV);
    const projY = new Float32Array(numV);
    const projZ = new Float32Array(numV);

    for (let i = 0; i < numV; i++) {
      const x0 = mesh.vertices[i * 3];
      const y0 = mesh.vertices[i * 3 + 1];
      const z0 = mesh.vertices[i * 3 + 2];

      const x1 = x0 * cosY + z0 * sinY;
      const y1 = y0;
      const z1 = -x0 * sinY + z0 * cosY;

      const x2 = x1;
      const y2 = y1 * cosX - z1 * sinX;
      const z2 = y1 * sinX + z1 * cosX;

      const distance = 3.2;
      const factor = distance / (distance - z2 * 0.65);

      projX[i] = cx + x2 * baseScale * factor;
      projY[i] = cy - y2 * baseScale * factor;
      projZ[i] = z2;
    }

    const edges = mesh.edges;
    for (let e = 0; e < edges.length - 1; e += 2) {
      const v1 = edges[e];
      const v2 = edges[e + 1];
      const avgZ = (projZ[v1] + projZ[v2]) / 2;
      const alpha = Math.max(0.25, Math.min(1, (avgZ + 1) / 2));
      ctx.strokeStyle =
        avgZ > 0 ? `rgba(0, 229, 255, ${alpha})` : `rgba(0, 121, 107, ${alpha})`;
      ctx.lineWidth = avgZ > 0.2 ? 1.6 : 1.0;
      ctx.beginPath();
      ctx.moveTo(projX[v1], projY[v1]);
      ctx.lineTo(projX[v2], projY[v2]);
      ctx.stroke();
    }
  }, [mesh, rotX, rotY, zoom]);

  return (
    <section className="rounded-2xl border border-[#DCE5D7] bg-white p-4 shadow-xs">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <div>
          <h3 className="text-base font-bold text-[#1C1D1A]">
            {isBn
              ? 'রোবট চ্যাসিস ৩ডি মডেল (3D Interactive Bot)'
              : '3D Robot Chassis (Interactive View)'}
          </h3>
          <p className="text-xs text-[#43483F]">
            {isBn
              ? 'FreeCAD (weed_robot_chassis.FCStd) থেকে সরাসরি এক্সট্রাক্টকৃত'
              : 'Directly extracted from FreeCAD (weed_robot_chassis.FCStd)'}
          </p>
        </div>
        <button
          type="button"
          onClick={() => {
            setRotX(25);
            setRotY(45);
            setZoom(1.0);
          }}
          className="inline-flex items-center gap-1 rounded-lg border border-[#C6D3C1] px-2.5 py-1.5 text-xs font-semibold text-[#1C1D1A] hover:bg-[#E2E7DD]/60"
        >
          <RotateCcw className="h-3.5 w-3.5" />
          {isBn ? 'রিসেট' : 'Reset'}
        </button>
      </div>

      <div className="relative overflow-hidden rounded-xl bg-[#1E281E]">
        {loading ? (
          <div className="flex h-[300px] items-center justify-center text-sm text-[#00E5FF]">
            Loading 3D chassis mesh...
          </div>
        ) : !mesh ? (
          <div className="flex h-[300px] items-center justify-center text-sm text-white">
            {isBn ? '৩ডি মডেল লোড করা যায়নি' : 'Failed to load 3D model'}
          </div>
        ) : (
          <canvas
            ref={canvasRef}
            width={800}
            height={360}
            onPointerDown={(e) => {
              dragRef.current = { x: e.clientX, y: e.clientY };
              e.currentTarget.setPointerCapture(e.pointerId);
            }}
            onPointerMove={(e) => {
              if (!dragRef.current) return;
              const dx = e.clientX - dragRef.current.x;
              const dy = e.clientY - dragRef.current.y;
              dragRef.current = { x: e.clientX, y: e.clientY };
              setRotY((prev) => (prev + dx * 0.5) % 360);
              setRotX((prev) => Math.max(-85, Math.min(85, prev - dy * 0.5)));
            }}
            onPointerUp={(e) => {
              dragRef.current = null;
              if (e.currentTarget.hasPointerCapture(e.pointerId)) {
                e.currentTarget.releasePointerCapture(e.pointerId);
              }
            }}
            className="h-[300px] w-full cursor-grab touch-none active:cursor-grabbing"
          />
        )}

        <div className="pointer-events-none absolute bottom-2 left-2 rounded-md bg-black/60 px-2.5 py-1 text-[11px] font-medium text-white">
          {isBn ? 'ড্র্যাগ করে ৩৬০° ঘুরিয়ে দেখুন' : 'Drag to rotate 360°'}
          {mesh ? ` · ${mesh.numTriangles} tris` : ''}
        </div>
      </div>

      <div className="mt-3 flex items-center gap-3 text-xs text-[#43483F]">
        <span className="font-semibold">{isBn ? 'জুম (Zoom):' : 'Zoom:'}</span>
        <input
          type="range"
          min={0.6}
          max={1.8}
          step={0.05}
          value={zoom}
          onChange={(e) => setZoom(Number(e.target.value))}
          className="flex-1 accent-[#2E7D32]"
        />
        <span className="w-10 text-right font-mono">{zoom.toFixed(2)}×</span>
      </div>
    </section>
  );
};
