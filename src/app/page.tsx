'use client';

import { useState, useRef, useCallback, useEffect } from 'react';
import dynamic from 'next/dynamic';

// Load ForceGraph only on client side (no SSR) — it uses browser APIs
const ForceGraph2D = dynamic(() => import('react-force-graph-2d'), { ssr: false });

// ─── Types ───────────────────────────────────────────────────────────────────
interface GraphNode {
  id: string;
  label: string;
  properties: Record<string, unknown>;
  x?: number;
  y?: number;
}

interface GraphLink {
  source: string;
  target: string;
  type: string;
}

interface Message {
  role: 'user' | 'assistant';
  text: string;
  rawQuery?: string;
}

// Label colours
const LABEL_COLOURS: Record<string, string> = {
  Customer:         '#60a5fa',
  SalesOrder:       '#34d399',
  DeliveryDocument: '#fbbf24',
  BillingDocument:  '#f87171',
  JournalEntry:     '#a78bfa',
};
const defaultColour = '#94a3b8';

// ─── Component ───────────────────────────────────────────────────────────────
export default function Home() {
  const [messages, setMessages]       = useState<Message[]>([]);
  const [input, setInput]             = useState('');
  const [loading, setLoading]         = useState(false);
  const [graphData, setGraphData]     = useState<{ nodes: GraphNode[]; links: GraphLink[] }>({ nodes: [], links: [] });
  const [selectedNode, setSelectedNode] = useState<GraphNode | null>(null);
  const chatEndRef = useRef<HTMLDivElement>(null);

  // Auto-scroll chat to bottom
  useEffect(() => { chatEndRef.current?.scrollIntoView({ behavior: 'smooth' }); }, [messages]);

  const sendMessage = async () => {
    const text = input.trim();
    if (!text || loading) return;
    setInput('');
    setLoading(true);
    setMessages(prev => [...prev, { role: 'user', text }]);

    try {
      const res = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: text }),
      });
      const data = await res.json();
      setMessages(prev => [...prev, { role: 'assistant', text: data.reply, rawQuery: data.rawQuery }]);
      if (data.nodes?.length) {
        setGraphData({ nodes: data.nodes, links: data.links || [] });
        setSelectedNode(null);
      }
    } catch {
      setMessages(prev => [...prev, { role: 'assistant', text: 'Error contacting the server.' }]);
    } finally {
      setLoading(false);
    }
  };

  const handleNodeClick = useCallback((node: object) => {
    setSelectedNode(node as GraphNode);
  }, []);

  const nodeCanvasObject = useCallback((node: object, ctx: CanvasRenderingContext2D, globalScale: number) => {
    const n = node as GraphNode;
    const label  = n.label || 'Node';
    const colour = LABEL_COLOURS[label] || defaultColour;
    const radius = 8;
    const fontSize = Math.max(10 / globalScale, 3);

    ctx.beginPath();
    ctx.arc(n.x ?? 0, n.y ?? 0, radius, 0, 2 * Math.PI);
    ctx.fillStyle = selectedNode?.id === n.id ? '#ffffff' : colour;
    ctx.fill();
    ctx.strokeStyle = colour;
    ctx.lineWidth = 1.5;
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
  }, [selectedNode]);

  return (
    <div className="flex h-screen overflow-hidden">

      {/* ── Left: Chat Sidebar ─────────────────────────────────────── */}
      <div className="w-[380px] min-w-[320px] flex flex-col bg-[#1a1a2e] border-r border-[#2d2d4e]">
        {/* Header */}
        <div className="px-5 py-4 border-b border-[#2d2d4e] bg-[#16213e]">
          <h1 className="text-lg font-bold text-blue-400">🔍 Graph Explorer</h1>
          <p className="text-xs text-slate-500 mt-0.5">Ask questions about your Neo4j data</p>
        </div>

        {/* Messages */}
        <div className="flex-1 overflow-y-auto p-4 flex flex-col gap-3">
          {messages.length === 0 && (
            <div className="text-center text-gray-600 mt-10 leading-relaxed">
              <div className="text-3xl mb-3">💬</div>
              <p>Ask a question about the supply chain data.</p>
              <p className="text-xs mt-2">e.g. &quot;Show me customer orders&quot;</p>
            </div>
          )}
          {messages.map((msg, i) => (
            <div key={i}>
              <div className={`max-w-[90%] px-3.5 py-2.5 text-sm leading-relaxed text-slate-200 ${
                msg.role === 'user'
                  ? 'ml-auto rounded-2xl rounded-br-sm bg-blue-600'
                  : 'mr-auto rounded-2xl rounded-bl-sm bg-slate-800'
              }`}>
                {msg.text}
              </div>
              {msg.rawQuery && (
                <details className="mt-1 ml-1">
                  <summary className="text-[11px] text-gray-600 cursor-pointer">View Cypher Query</summary>
                  <pre className="text-[11px] text-slate-400 bg-[#0f172a] p-2 rounded-md mt-1 overflow-x-auto whitespace-pre-wrap">
                    {msg.rawQuery}
                  </pre>
                </details>
              )}
            </div>
          ))}
          {loading && (
            <div className="text-gray-600 text-[13px] italic">Thinking…</div>
          )}
          <div ref={chatEndRef} />
        </div>

        {/* Input */}
        <div className="px-4 py-3 border-t border-[#2d2d4e] flex gap-2">
          <input
            value={input}
            onChange={e => setInput(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && sendMessage()}
            placeholder="Ask about orders, billing…"
            disabled={loading}
            className="flex-1 px-3.5 py-2.5 rounded-[10px] border border-[#2d2d4e] bg-[#0f172a] text-slate-200 text-sm outline-none focus:border-blue-500 transition-colors"
          />
          <button
            onClick={sendMessage}
            disabled={loading || !input.trim()}
            className={`px-4 py-2.5 rounded-[10px] border-none text-slate-200 text-sm font-semibold transition-colors ${
              loading || !input.trim() ? 'bg-slate-800 cursor-default' : 'bg-blue-600 cursor-pointer hover:bg-blue-500'
            }`}
          >
            Send
          </button>
        </div>
      </div>

      {/* ── Right: Graph + Node Inspector ──────────────────────────── */}
      <div className="flex-1 relative bg-[#0f0f1a] overflow-hidden">
        {graphData.nodes.length === 0 ? (
          <div className="absolute inset-0 flex items-center justify-center flex-col text-[#2d2d4e]">
            <div className="text-6xl mb-4">🕸️</div>
            <p className="text-base">Graph will appear here after your first query</p>
          </div>
        ) : (
          <ForceGraph2D
            graphData={graphData}
            nodeId="id"
            nodeCanvasObject={nodeCanvasObject}
            nodeCanvasObjectMode={() => 'replace'}
            linkLabel={(link: any) => link.type}
            linkColor={() => '#334155'}
            linkDirectionalArrowLength={6}
            linkDirectionalArrowRelPos={1}
            onNodeClick={handleNodeClick}
            backgroundColor="#0f0f1a"
          />
        )}

        {/* Legend */}
        <div className="absolute top-4 left-4 bg-[#0f0f1a]/85 rounded-[10px] px-3.5 py-2.5 backdrop-blur-sm">
          {Object.entries(LABEL_COLOURS).map(([label, colour]) => (
            <div key={label} className="flex items-center gap-2 mb-1">
              <div className="w-2.5 h-2.5 rounded-full" style={{ background: colour }} />
              <span className="text-xs text-slate-400">{label}</span>
            </div>
          ))}
        </div>

        {/* Node Inspector Panel */}
        {selectedNode && (
          <div className="absolute top-4 right-4 w-[260px] bg-[#16213e]/95 rounded-xl p-4 border border-[#2d2d4e] backdrop-blur-sm">
            <div className="flex justify-between items-center mb-3">
              <span
                className="text-xs font-bold px-2 py-0.5 rounded-md text-black"
                style={{ background: LABEL_COLOURS[selectedNode.label] || defaultColour }}
              >
                {selectedNode.label}
              </span>
              <button
                onClick={() => setSelectedNode(null)}
                className="bg-transparent border-none text-slate-500 cursor-pointer text-base hover:text-slate-300"
              >×</button>
            </div>
            <div className="flex flex-col gap-1.5">
              {Object.entries(selectedNode.properties).map(([k, v]) => (
                <div key={k} className="text-xs">
                  <span className="text-slate-500">{k}: </span>
                  <span className="text-slate-200">{String(v)}</span>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
