import React, { useEffect, useRef, useState } from 'react';
import { Upload, Eye, ShieldAlert, CheckCircle2, HelpCircle } from 'lucide-react';
import { DEMO_PHOTO_ASSETS } from '../core/networkData';
import { NetworkNode, VisionAnalysisResult } from '../core/types';

interface VisionIntelligenceViewProps {
  nodes: NetworkNode[];
  selectedNodeId: string;
  onSelectNode: (nodeId: string) => void;
  visionAnalyses: VisionAnalysisResult[];
  /** Solo OPERATOR y ADMIN pueden pedir anÃ¡lisis; el servidor lo exige igualmente. */
  canAnalyze?: boolean;
  onAnalyzeVision: (payload: {
    nodeId: string;
    imageUrl: string;
    imageTitle: string;
    imageBase64?: string;
    imageMimeType?: string;
  }) => Promise<VisionAnalysisResult>;
}

const DEMO_GALLERY = [
  {
    id: 'gal-leak',
    nodeId: 'N-TRON-04',
    title: 'Inspección cámara Troncal Norte — Brida PVC fracturada',
    url: DEMO_PHOTO_ASSETS.leak,
  },
  {
    id: 'gal-turbid',
    nodeId: 'N-TOMA-01',
    title: 'Reporte en Bocatoma Quebrada Alta — Agua marrón turbia',
    url: DEMO_PHOTO_ASSETS.contamination,
  },
  {
    id: 'gal-valve',
    nodeId: 'N-VALV-05',
    title: 'Cámara Válvula Sur — Corrosión e incrustaciones en compuerta',
    url: DEMO_PHOTO_ASSETS.obstruction,
  },
];

export const VisionIntelligenceView: React.FC<VisionIntelligenceViewProps> = ({
  nodes,
  selectedNodeId,
  onSelectNode,
  visionAnalyses,
  onAnalyzeVision,
  canAnalyze = true,
}) => {
  const selectedNode = nodes.find((n) => n.id === selectedNodeId) ?? nodes[0];
  const latestForNode = visionAnalyses.find((v) => v.nodeId === selectedNode.id) ?? null;

  const [previewUrl, setPreviewUrl] = useState<string>(() => {
    const gal = DEMO_GALLERY.find((g) => g.nodeId === selectedNode.id);
    return latestForNode?.imageUrl ?? gal?.url ?? '';
  });
  const [imageTitle, setImageTitle] = useState<string>(() => {
    const gal = DEMO_GALLERY.find((g) => g.nodeId === selectedNode.id);
    return (
      latestForNode?.imageTitle ??
      gal?.title ??
      `Sin fotografía precargada para ${selectedNode.name}`
    );
  });
  const [uploadedBase64, setUploadedBase64] = useState<string | undefined>(undefined);
  const [uploadedMime, setUploadedMime] = useState<string | undefined>(undefined);
  const [imgFailed, setImgFailed] = useState(false);
  const [analyzing, setAnalyzing] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const manualUploadNodeRef = useRef<string | null>(null);

  useEffect(() => {
    if (manualUploadNodeRef.current === selectedNode.id && uploadedBase64) {
      return;
    }
    manualUploadNodeRef.current = null;
    const nodeAnalysis = visionAnalyses.find((v) => v.nodeId === selectedNode.id);
    const galleryMatch = DEMO_GALLERY.find((g) => g.nodeId === selectedNode.id);
    if (nodeAnalysis && nodeAnalysis.imageUrl) {
      setPreviewUrl(nodeAnalysis.imageUrl);
      setImageTitle(nodeAnalysis.imageTitle);
    } else if (galleryMatch) {
      setPreviewUrl(galleryMatch.url);
      setImageTitle(galleryMatch.title);
    } else {
      setPreviewUrl('');
      setImageTitle(`Sin fotografía precargada para ${selectedNode.name} (${selectedNode.id})`);
    }
    setUploadedBase64(undefined);
    setUploadedMime(undefined);
    setImgFailed(false);
  }, [selectedNode.id, selectedNode.name, visionAnalyses, uploadedBase64]);

  const handlePhotoUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === 'string') {
        manualUploadNodeRef.current = selectedNode.id;
        setPreviewUrl(reader.result);
        setImageTitle(`Fotografía subida: ${file.name}`);
        setImgFailed(false);
        const match = reader.result.match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/);
        if (match) {
          setUploadedMime(match[1]);
          setUploadedBase64(match[2]);
        }
      }
    };
    reader.readAsDataURL(file);
  };

  const handleRunAnalysis = async () => {
    setAnalyzing(true);
    setErrorMsg(null);
    try {
      await onAnalyzeVision({
        nodeId: selectedNode.id,
        imageUrl: previewUrl,
        imageTitle,
        imageBase64: uploadedBase64,
        imageMimeType: uploadedMime,
      });
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Error analizando la fotografía.');
    } finally {
      setAnalyzing(false);
    }
  };

  return (
    <div className="space-y-6">
      <section className="bg-[#0A1D29] border border-[#18364A] rounded-xl p-5 flex flex-wrap items-center justify-between gap-4">
        <div>
          <h2 className="text-lg font-semibold text-white">Visión Multimodal de Infraestructura</h2>
          <p className="text-xs text-slate-400 mt-1">
            Cruza reportes fotográficos con telemetría y topología. Distingue estrictamente hechos
            visuales de inferencias e incertidumbre.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-3">
          <label htmlFor="vision-node-select" className="sr-only">
            Nodo correlacionado
          </label>
          <select
            id="vision-node-select"
            value={selectedNode.id}
            onChange={(e) => onSelectNode(e.target.value)}
            className="px-3 py-2 text-xs bg-[#06131C] text-slate-100 border border-[#234C66] rounded-lg focus:outline-none focus:border-cyan-400"
          >
            {nodes.map((n) => (
              <option key={n.id} value={n.id}>
                {n.name} ({n.id})
              </option>
            ))}
          </select>

          <label className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-medium bg-[#06131C] hover:bg-[#0F2736] text-slate-200 border border-[#234C66] rounded-lg cursor-pointer whitespace-nowrap shrink-0">
            <Upload className="w-3.5 h-3.5" />
            Subir Foto
            <input type="file" accept="image/*" onChange={handlePhotoUpload} className="sr-only" />
          </label>

          <button
            type="button"
            disabled={analyzing || !canAnalyze}
            onClick={handleRunAnalysis}
            className="inline-flex items-center gap-2 px-4 py-2 text-xs font-semibold bg-cyan-500 hover:bg-cyan-400 text-[#041018] rounded-lg transition-colors whitespace-nowrap shrink-0 cursor-pointer disabled:opacity-50"
          >
            <Eye className="w-3.5 h-3.5" />
            {analyzing ? 'Analizando...' : 'Analizar Evidencia Multimodal'}
          </button>
        </div>
      </section>

      <section className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
        {/* Image Stage & Demo Gallery */}
        <div className="lg:col-span-5 bg-[#0A1D29] border border-[#18364A] rounded-xl p-5 space-y-4">
          <div className="aspect-[4/3] w-full rounded-lg overflow-hidden bg-[#06131C] border border-[#18364A] flex items-center justify-center">
            {!imgFailed && previewUrl ? (
              <img
                src={previewUrl}
                alt={imageTitle}
                referrerPolicy="no-referrer"
                onError={() => setImgFailed(true)}
                className="w-full h-full object-cover"
              />
            ) : (
              <div className="p-6 text-center space-y-2">
                <Eye className="w-6 h-6 text-cyan-400 mx-auto" />
                <p className="text-xs text-slate-300">{imageTitle}</p>
              </div>
            )}
          </div>

          <div className="space-y-1">
            <p className="text-xs font-medium text-white">{imageTitle}</p>
            <p className="text-xs font-mono text-slate-400">
              Sensor asociado ({selectedNode.id}): {selectedNode.current.pressureBar} bar ·{' '}
              {selectedNode.current.flowLs} L/s · {selectedNode.current.turbidityNtu} NTU
            </p>
          </div>

          <div className="pt-2 border-t border-[#18364A] space-y-2">
            <p className="text-xs text-slate-400">Fotografías de campo del escenario:</p>
            <div className="grid grid-cols-3 gap-2">
              {DEMO_GALLERY.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => {
                    manualUploadNodeRef.current = null;
                    setPreviewUrl(item.url);
                    setImageTitle(item.title);
                    setUploadedBase64(undefined);
                    setUploadedMime(undefined);
                    setImgFailed(false);
                    onSelectNode(item.nodeId);
                  }}
                  className={`p-2 text-left rounded-lg border transition-colors cursor-pointer ${
                    previewUrl === item.url
                      ? 'bg-[#0F2736] border-cyan-400 text-cyan-200'
                      : 'bg-[#06131C] border-[#18364A] text-slate-400 hover:text-slate-200'
                  }`}
                >
                  <div className="text-xs font-semibold truncate">{item.nodeId}</div>
                  <div className="text-xs truncate mt-0.5">{item.title.split('—')[1]?.trim() || item.title}</div>
                </button>
              ))}
            </div>
          </div>
        </div>

        {/* Multimodal Epistemic Breakdown */}
        <div className="lg:col-span-7 bg-[#0A1D29] border border-[#18364A] rounded-xl p-5 space-y-5">
          {errorMsg && (
            <div className="p-3 rounded-lg bg-[#06131C] border border-rose-500/40 text-xs text-rose-300">
              {errorMsg}
            </div>
          )}

          {!latestForNode ? (
            <div className="py-12 text-center border border-dashed border-[#18364A] rounded-lg space-y-2">
              <Eye className="w-6 h-6 text-cyan-400 mx-auto" />
              <p className="text-sm text-slate-200">
                Selecciona o sube una fotografía y pulsa "Analizar Evidencia Multimodal".
              </p>
              <p className="text-xs text-slate-400 max-w-md mx-auto">
                Un proveedor de visión (si está configurado) analiza la imagen SIN conocer las lecturas de {selectedNode.name}; luego el servidor compara su categoría con la del incidente. Sin proveedor, la imagen queda registrada como no analizada.
              </p>
            </div>
          ) : (
            <div className="space-y-5">
              <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[#18364A] pb-3">
                <div>
                  <h3 className="text-base font-semibold text-white">{latestForNode.imageTitle}</h3>
                  <p className="text-xs text-slate-400 mt-0.5">
                    Proveedor: <span className="text-cyan-300">{latestForNode.providerUsed}</span> ·{' '}
                    {latestForNode.analysisStatus === 'analyzed' ? 'Analizada por un proveedor de visión' : latestForNode.analysisStatus === 'pending' ? 'Análisis en curso' : 'NO analizada'} ·{' '}
                    {latestForNode.anomalyId ? `Vinculada al incidente ${latestForNode.anomalyId}` : 'Sin incidente asociado (no cuenta como evidencia)'}
                  </p>
                </div>
                <span className="text-xs font-mono text-slate-400">
                  {latestForNode.id}
                </span>
              </div>

              <div className="p-3.5 rounded-lg bg-[#06131C] border border-[#234C66] text-xs text-slate-200 leading-relaxed">
                <span className="font-semibold text-cyan-300">Correlación imagen-sensor: </span>
                {latestForNode.sensorCorrelationSummary}
                {latestForNode.analysisStatus === 'not_analyzed' && latestForNode.notAnalyzedReason && (
                  <span className="block mt-1 text-amber-300">{latestForNode.notAnalyzedReason}</span>
                )}
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div className="p-4 rounded-lg bg-[#06131C] border border-[#18364A] space-y-2">
                  <div className="flex items-center gap-1.5 text-xs font-semibold text-emerald-400">
                    <CheckCircle2 className="w-4 h-4" />
                    Lo observado directamente
                  </div>
                  <ul className="space-y-1.5 text-xs text-slate-300 list-disc pl-4">
                    {latestForNode.observed.length === 0 && <li className="list-none -ml-4 text-slate-400">Sin observaciones: la imagen no fue analizada.</li>}
                    {latestForNode.observed.map((item, idx) => (
                      <li key={idx}>{item}</li>
                    ))}
                  </ul>
                </div>

                <div className="p-4 rounded-lg bg-[#06131C] border border-[#18364A] space-y-2">
                  <div className="flex items-center gap-1.5 text-xs font-semibold text-cyan-400">
                    <Eye className="w-4 h-4" />
                    Inferencia al cruzar con sensores
                  </div>
                  <ul className="space-y-1.5 text-xs text-slate-300 list-disc pl-4">
                    {latestForNode.inferred.length === 0 && <li className="list-none -ml-4 text-slate-400">Sin inferencias.</li>}
                    {latestForNode.inferred.map((item, idx) => (
                      <li key={idx}>{item}</li>
                    ))}
                  </ul>
                </div>

                <div className="p-4 rounded-lg bg-[#06131C] border border-[#18364A] space-y-2">
                  <div className="flex items-center gap-1.5 text-xs font-semibold text-amber-400">
                    <ShieldAlert className="w-4 h-4" />
                    No determinable solo por fotografía
                  </div>
                  <ul className="space-y-1.5 text-xs text-slate-300 list-disc pl-4">
                    {latestForNode.cannotDetermine.map((item, idx) => (
                      <li key={idx}>{item}</li>
                    ))}
                  </ul>
                </div>

                <div className="p-4 rounded-lg bg-[#06131C] border border-[#18364A] space-y-2">
                  <div className="flex items-center gap-1.5 text-xs font-semibold text-slate-300">
                    <HelpCircle className="w-4 h-4 text-sky-400" />
                    Datos o pruebas faltantes
                  </div>
                  <ul className="space-y-1.5 text-xs text-slate-300 list-disc pl-4">
                    {latestForNode.missingData.map((item, idx) => (
                      <li key={idx}>{item}</li>
                    ))}
                  </ul>
                </div>
              </div>
            </div>
          )}
        </div>
      </section>
    </div>
  );
};
