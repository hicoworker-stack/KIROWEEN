import React from 'react';
import { analyzeNetworkHydraulics } from '../core/graphHydrology';
import { AnomalyEvent, NetworkNode, PipeSegment } from '../core/types';
import { HEALTH_META, HealthKey, nodeHealth } from '../ui/vocab';

interface NetworkMapProps {
  nodes: NetworkNode[];
  pipes: PipeSegment[];
  anomalies?: AnomalyEvent[];
  selectedNodeId: string;
  onSelectNode: (nodeId: string) => void;
}

const COLOR: Record<HealthKey, { stroke: string; fill: string; glyph: string; mark: string }> = {
  stable: { stroke: '#34D399', fill: '#07261F', glyph: '#6EE7B7', mark: '✓' },
  attention: { stroke: '#FBBF24', fill: '#2B2007', glyph: '#FCD34D', mark: '!' },
  critical: { stroke: '#FB7185', fill: '#33101B', glyph: '#FDA4AF', mark: '✕' },
  verifying: { stroke: '#A5B4FC', fill: '#1B1F3D', glyph: '#C7D2FE', mark: '?' },
  offline: { stroke: '#94A3B8', fill: '#1E2733', glyph: '#CBD5E1', mark: '–' },
};

/** Parte un nombre largo en dos líneas para que se lea completo en el mapa. */
function splitLabel(name: string): string[] {
  if (name.length <= 20) return [name];
  const words = name.split(' ');
  let best = 0;
  let bestDiff = Infinity;
  for (let i = 1; i < words.length; i++) {
    const diff = Math.abs(words.slice(0, i).join(' ').length - words.slice(i).join(' ').length);
    if (diff < bestDiff) {
      best = i;
      bestDiff = diff;
    }
  }
  return best === 0 ? [name] : [words.slice(0, best).join(' '), words.slice(best).join(' ')];
}

/** Zonas de la red, sin cotas ni códigos: orientan, no abruman. */
const ZONES: Array<{ d: string; label: string; lx: number; ly: number }> = [
  { d: 'M 30 40 L 350 40 L 350 220 L 30 220 Z', label: 'Parte alta', lx: 44, ly: 62 },
  { d: 'M 370 35 L 870 35 L 870 205 L 370 205 Z', label: 'Norte y centro', lx: 384, ly: 57 },
  { d: 'M 370 218 L 870 218 L 870 355 L 370 355 Z', label: 'Sur', lx: 384, ly: 240 },
];

/**
 * Mapa esquemático de la red. Cada nodo se identifica por su nombre y su estado se comunica con color, símbolo y texto.
 * Los diámetros, cotas y códigos de activo viven en el detalle del nodo, no en el mapa.
 */
export const NetworkMap: React.FC<NetworkMapProps> = ({ nodes, pipes, anomalies = [], selectedNodeId, onSelectNode }) => {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const hydraulics = analyzeNetworkHydraulics(nodes, pipes, anomalies);
  const activeNodeIds = new Set(anomalies.filter((a) => a.status === 'active').map((a) => a.nodeId));

  return (
    <div className="overflow-x-auto rounded-xl border border-line bg-[#071824]" data-testid="network-map-container">
      <svg viewBox="0 0 900 380" className="block h-auto w-full min-w-[680px] select-none" role="group" aria-label="Mapa esquemático de la red de agua. Cada punto es un lugar de la red y se puede seleccionar.">
        <rect width="900" height="380" fill="#071824" />
        {ZONES.map((z) => (
          <g key={z.label} aria-hidden="true">
            <path d={z.d} fill="#0B2231" fillOpacity="0.4" stroke="#17384D" strokeDasharray="4 4" />
            <text x={z.lx} y={z.ly} fill="#6C93A8" fontSize="13" fontWeight="600">
              {z.label}
            </text>
          </g>
        ))}

        {pipes.map((pipe) => {
          const a = byId.get(pipe.from);
          const b = byId.get(pipe.to);
          if (!a || !b) return null;
          const hs = [nodeHealth(a), nodeHealth(b)];
          const propagated = hydraulics.affectedPipeIds.includes(pipe.id);
          const color = hs.includes('critical') ? COLOR.critical.stroke : propagated || hs.includes('attention') ? COLOR.attention.stroke : hs.includes('verifying') ? COLOR.verifying.stroke : '#1B7C94';
          const affected = propagated || hs.some((h) => h !== 'stable');
          return <line key={pipe.id} x1={a.x} y1={a.y} x2={b.x} y2={b.y} stroke={color} strokeWidth={affected ? 4 : 3} strokeOpacity={affected ? 0.95 : 0.6} strokeDasharray={propagated && !hs.includes('critical') ? '7 5' : undefined} strokeLinecap="round" />;
        })}

        {nodes.map((node) => {
          const h = nodeHealth(node);
          const c = COLOR[h];
          const selected = node.id === selectedNodeId;
          const risk = hydraulics.propagatedByNode[node.id];
          const hasIncident = activeNodeIds.has(node.id);
          const lines = splitLabel(node.name);
          const state = risk && h === 'stable' ? `en riesgo por lo que ocurre en ${risk.sourceNodeName}` : HEALTH_META[h].label.toLowerCase();
          return (
            <g
              key={node.id}
              transform={`translate(${node.x}, ${node.y})`}
              role="button"
              tabIndex={0}
              aria-pressed={selected}
              aria-label={`${node.name}: ${state}${hasIncident ? ', con incidente activo' : ''}`}
              onClick={() => onSelectNode(node.id)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  onSelectNode(node.id);
                }
              }}
              className="cursor-pointer focus:outline-none"
            >
              {(hasIncident || risk) && <circle r="38" fill={risk && !hasIncident ? '#FBBF24' : c.stroke} fillOpacity="0.1" stroke={risk && !hasIncident ? '#FBBF24' : c.stroke} strokeDasharray="4 4" strokeWidth="1.5" />}
              {selected && <circle r="31" fill="none" stroke="#22D3EE" strokeWidth="3" />}
              <circle r="23" fill={c.fill} stroke={c.stroke} strokeWidth="3" />
              <text y="6" textAnchor="middle" fill={c.glyph} fontSize="19" fontWeight="700">
                {c.mark}
              </text>
              <rect x="-78" y="30" width="156" height={lines.length > 1 ? 40 : 26} rx="6" fill="#06131C" fillOpacity="0.92" stroke={selected ? '#22D3EE' : '#18364A'} />
              {lines.map((line, i) => (
                <text key={i} y={47 + i * 15} textAnchor="middle" fill="#E6F1F5" fontSize="13" fontWeight="600">
                  {line}
                </text>
              ))}
            </g>
          );
        })}
      </svg>
    </div>
  );
};
