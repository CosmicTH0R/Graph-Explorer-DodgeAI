'use client';

import { useCallback } from 'react';
import dynamic from 'next/dynamic';
import { GraphNode, GraphLink, LABEL_COLOURS, defaultColour } from './types';

const ForceGraph2D = dynamic(() => import('react-force-graph-2d'), { ssr: false });

interface GraphCanvasProps {
  graphData: { nodes: GraphNode[]; links: GraphLink[] };
  selectedNodeId: string | null;
  highlightedIds: Set<string>;
  onNodeClick: (node: GraphNode) => void;
  onNodeRightClick: (node: GraphNode) => void;
}

export default function GraphCanvas({ graphData, selectedNodeId, highlightedIds, onNodeClick, onNodeRightClick }: GraphCanvasProps) {
  const nodeCanvasObject = useCallback((node: object, ctx: CanvasRenderingContext2D, globalScale: number) => {
    const n = node as GraphNode;
    const label  = n.label || 'Node';
    const colour = LABEL_COLOURS[label] || defaultColour;
    const radius = 8;
    const fontSize = Math.max(10 / globalScale, 3);
    const isHighlighted = highlightedIds.has(n.id);

    // Glow ring for highlighted (referenced) nodes
    if (isHighlighted) {
      ctx.beginPath();
      ctx.arc(n.x ?? 0, n.y ?? 0, radius + 4, 0, 2 * Math.PI);
      ctx.fillStyle = 'rgba(250, 204, 21, 0.25)';
      ctx.fill();
      ctx.strokeStyle = '#facc15';
      ctx.lineWidth = 2;
      ctx.stroke();
    }

    ctx.beginPath();
    ctx.arc(n.x ?? 0, n.y ?? 0, radius, 0, 2 * Math.PI);
    ctx.fillStyle = selectedNodeId === n.id ? '#ffffff' : colour;
    ctx.fill();
    ctx.strokeStyle = isHighlighted ? '#facc15' : colour;
    ctx.lineWidth = isHighlighted ? 2 : 1.5;
    ctx.stroke();

    ctx.font = `${fontSize}px sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = '#fff';
    ctx.fillText(
      String((n.properties as any)?.id ?? label),
      n.x ?? 0,
      (n.y ?? 0) + radius + fontSize,
    );
  }, [selectedNodeId, highlightedIds]);

  if (graphData.nodes.length === 0) {
    return (
      <div className="absolute inset-0 flex items-center justify-center flex-col text-[#2d2d4e]">
        <div className="text-6xl mb-4">🕸️</div>
        <p className="text-base">Graph will appear here after your first query</p>
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
      linkColor={() => '#334155'}
      linkDirectionalArrowLength={6}
      linkDirectionalArrowRelPos={1}
      onNodeClick={(node: object) => onNodeClick(node as GraphNode)}
      onNodeRightClick={(node: object) => onNodeRightClick(node as GraphNode)}
      backgroundColor="#0f0f1a"
    />
  );
}
