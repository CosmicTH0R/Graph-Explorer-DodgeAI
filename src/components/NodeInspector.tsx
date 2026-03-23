'use client';

import { GraphNode, LABEL_COLOURS, defaultColour } from './types';

interface NodeInspectorProps {
  node: GraphNode;
  onClose: () => void;
}

export default function NodeInspector({ node, onClose }: NodeInspectorProps) {
  return (
    <div className="absolute top-4 right-4 w-[260px] bg-[#16213e]/95 rounded-xl p-4 border border-[#2d2d4e] backdrop-blur-sm">
      <div className="flex justify-between items-center mb-3">
        <span
          className="text-xs font-bold px-2 py-0.5 rounded-md text-black"
          style={{ background: LABEL_COLOURS[node.label] || defaultColour }}
        >
          {node.label}
        </span>
        <button
          onClick={onClose}
          className="bg-transparent border-none text-slate-500 cursor-pointer text-base hover:text-slate-300"
        >×</button>
      </div>
      <div className="flex flex-col gap-1.5">
        {Object.entries(node.properties).map(([k, v]) => (
          <div key={k} className="text-xs">
            <span className="text-slate-500">{k}: </span>
            <span className="text-slate-200 break-all">
              {typeof v === 'object' && v !== null ? JSON.stringify(v) : String(v)}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
