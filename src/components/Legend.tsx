'use client';

import { LABEL_COLOURS } from './types';

interface LegendProps {
  expanding: boolean;
}

export default function Legend({ expanding }: LegendProps) {
  return (
    <div className="absolute top-4 left-4 bg-[#0f0f1a]/85 rounded-[10px] px-3.5 py-2.5 backdrop-blur-sm">
      {Object.entries(LABEL_COLOURS).map(([label, colour]) => (
        <div key={label} className="flex items-center gap-2 mb-1">
          <div className="w-2.5 h-2.5 rounded-full" style={{ background: colour }} />
          <span className="text-xs text-slate-400">{label}</span>
        </div>
      ))}
      {expanding && <div className="text-[11px] text-blue-400 mt-1 animate-pulse">Expanding…</div>}
    </div>
  );
}
