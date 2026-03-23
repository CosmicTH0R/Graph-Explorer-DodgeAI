'use client';

import { useCallback, useRef } from 'react';
import dynamic from 'next/dynamic';
import { GraphNode, GraphLink, LABEL_COLOURS, defaultColour } from './types';

const ForceGraph2D = dynamic(() => import('react-force-graph-2d'), { ssr: false });

interface GraphCanvasProps {
  graphData: { nodes: GraphNode[]; links: GraphLink[] };
  selectedNodeId: string | null;
  highlightedIds: Set<string>;
  onNodeClick: (node: GraphNode) => void;
  onNodeRightClick: (node: GraphNode) => void;
  onBackgroundClick?: () => void;
}

export default function GraphCanvas({ graphData, selectedNodeId, highlightedIds, onNodeClick, onNodeRightClick, onBackgroundClick }: GraphCanvasProps) {
  const fgRef = useRef<any>(null);
  const hasHighlights = highlightedIds.size > 0;

  const nodeCanvasObject = useCallback((node: object, ctx: CanvasRenderingContext2D, globalScale: number) => {
    const n = node as GraphNode;
    const label   = n.label || 'Node';
    const colour  = LABEL_COLOURS[label] || defaultColour;
    const radius  = 8;
    const fontSize = Math.max(10 / globalScale, 3);
    const isHighlighted = highlightedIds.has(n.id);
    const isSelected    = selectedNodeId === n.id;
    const isDimmed      = hasHighlights && !isHighlighted && !isSelected;

    // Dim non-highlighted nodes when a highlight set is active
    ctx.globalAlpha = isDimmed ? 0.12 : 1;

    // Node circle
    ctx.beginPath();
    ctx.arc(n.x ?? 0, n.y ?? 0, isHighlighted ? 10 : radius, 0, 2 * Math.PI);
    ctx.fillStyle = isSelected ? '#ffffff' : colour;
    ctx.fill();

    // Border
    ctx.strokeStyle = isHighlighted ? '#facc15' : colour;
    ctx.lineWidth   = isHighlighted ? 2.5 : 1.5;
    ctx.stroke();

    // Soft halo behind highlighted nodes
    if (isHighlighted) {
      ctx.beginPath();
      ctx.arc(n.x ?? 0, n.y ?? 0, 14, 0, 2 * Math.PI);
      ctx.fillStyle = colour + '33'; // 20% opacity halo using hex alpha
      ctx.fill();
    }

    // Label
    ctx.font = `${fontSize}px sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = isDimmed ? '#4b5563' : '#e2e8f0';
    ctx.fillText(
      String((n.properties as any)?.id ?? label),
      n.x ?? 0,
      (n.y ?? 0) + (isHighlighted ? 12 : radius) + fontSize,
    );

    ctx.globalAlpha = 1;
  }, [selectedNodeId, highlightedIds, hasHighlights]);

  const getLinkColor = useCallback((link: object) => {
    if (!hasHighlights) return '#334155';
    const l = link as any;
    const src = typeof l.source === 'object' ? l.source?.id : l.source;
    const tgt = typeof l.target === 'object' ? l.target?.id : l.target;
    const srcHL = highlightedIds.has(src);
    const tgtHL = highlightedIds.has(tgt);
    if (srcHL && tgtHL) return '#60a5fa';  // both endpoints highlighted → bright blue
    if (srcHL || tgtHL) return '#2d4a6b';  // one end highlighted → subtle blue
    return '#1a2033';                       // not related → nearly invisible
  }, [highlightedIds, hasHighlights]);

  const getLinkWidth = useCallback((link: object) => {
    if (!hasHighlights) return 1;
    const l = link as any;
    const src = typeof l.source === 'object' ? l.source?.id : l.source;
    const tgt = typeof l.target === 'object' ? l.target?.id : l.target;
    return (highlightedIds.has(src) && highlightedIds.has(tgt)) ? 2 : 1;
  }, [highlightedIds, hasHighlights]);

  if (graphData.nodes.length === 0) {
    return (
      <div className="absolute inset-0 flex items-center justify-center flex-col text-[#2d2d4e]">
        <div className="w-8 h-8 border-2 border-[#2d2d4e] border-t-blue-500 rounded-full animate-spin mb-4" />
        <p className="text-sm">Loading graph…</p>
      </div>
    );
  }

  return (
    <ForceGraph2D
      graphData={graphData}
      nodeId="id"
      nodeCanvasObject={nodeCanvasObject}
      nodeCanvasObjectMode={() => 'replace'}
      linkLabel={(link: any) => link.type}
      linkColor={getLinkColor}
      linkWidth={getLinkWidth}
      linkDirectionalArrowLength={6}
      linkDirectionalArrowRelPos={1}
      ref={fgRef}
      onNodeClick={(node: object) => {
        const n = node as GraphNode;
        if (fgRef.current) {
          fgRef.current.centerAt(n.x ?? 0, n.y ?? 0, 600);
          fgRef.current.zoom(6, 600);
        }
        onNodeClick(n);
      }}
      onNodeRightClick={(node: object) => onNodeRightClick(node as GraphNode)}
      onBackgroundClick={onBackgroundClick}
      backgroundColor="#0f0f1a"
    />
  );
}
