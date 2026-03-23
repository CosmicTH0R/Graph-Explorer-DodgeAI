'use client';

import { useState, useCallback, useRef, useEffect } from 'react';
import ChatSidebar from '@/components/ChatSidebar';
import GraphCanvas from '@/components/GraphCanvas';
import Legend from '@/components/Legend';
import NodeInspector from '@/components/NodeInspector';
import { GraphNode, GraphLink, Message } from '@/components/types';

export default function Home() {
  const [messages, setMessages]       = useState<Message[]>([]);
  const [input, setInput]             = useState('');
  const [loading, setLoading]         = useState(false);
  const [graphData, setGraphData]     = useState<{ nodes: GraphNode[]; links: GraphLink[] }>({ nodes: [], links: [] });
  const [selectedNode, setSelectedNode] = useState<GraphNode | null>(null);
  const [expanding, setExpanding]       = useState(false);
  const [expandError, setExpandError]   = useState<string | null>(null);
  const [highlightedIds, setHighlightedIds] = useState<Set<string>>(new Set());
  const [streaming, setStreaming]             = useState(false);
  const abortControllerRef = useRef<AbortController | null>(null);

  // Merge helper — deduplicates nodes and links by id/key
  const mergeGraphData = useCallback((newNodes: GraphNode[], newLinks: GraphLink[]) => {
    setGraphData(prev => {
      const existingNodeIds  = new Set(prev.nodes.map(n => n.id));
      const existingLinkKeys = new Set(prev.links.map(l => {
        const s = typeof l.source === 'object' ? (l.source as any).id : l.source;
        const t = typeof l.target === 'object' ? (l.target as any).id : l.target;
        return `${s}-${l.type}-${t}`;
      }));
      const addNodes = newNodes.filter(n => !existingNodeIds.has(n.id));
      const addLinks = newLinks.filter(l => {
        const s = typeof l.source === 'object' ? (l.source as any).id : String(l.source);
        const t = typeof l.target === 'object' ? (l.target as any).id : String(l.target);
        return !existingLinkKeys.has(`${s}-${l.type}-${t}`);
      });
      return { nodes: [...prev.nodes, ...addNodes], links: [...prev.links, ...addLinks] };
    });
  }, []);

  // Load the full overview graph on mount
  useEffect(() => {
    fetch('/api/overview')
      .then(r => r.json())
      .then(data => {
        if (data.nodes?.length) {
          setGraphData({ nodes: data.nodes, links: data.links || [] });
        }
      })
      .catch(() => {}); // silently ignore — graph starts empty if DB unreachable
  }, []);

  useEffect(() => { return () => { abortControllerRef.current?.abort(); }; }, []);

  const sendMessage = async () => {
    const text = input.trim();
    if (!text || loading) return;
    setInput('');
    setLoading(true);
    setMessages(prev => [...prev, { role: 'user', text }]);

    abortControllerRef.current?.abort();
    const controller = new AbortController();
    abortControllerRef.current = controller;

    const recentHistory = [...messages, { role: 'user' as const, text }]
      .slice(-10)
      .map(m => ({ role: m.role, text: m.text }));

    try {
      const res = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: text, history: recentHistory }),
        signal: controller.signal,
      });

      const contentType = res.headers.get('content-type') || '';

      if (contentType.includes('text/event-stream')) {
        // --- SSE streaming path ---
        let rawQuery: string | undefined;
        let assistantText = '';
        // Add a placeholder assistant message that we'll update progressively
        setMessages(prev => [...prev, { role: 'assistant', text: '' }]);
        setStreaming(true);

        const reader = res.body!.getReader();
        const decoder = new TextDecoder();
        let buffer = '';

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });

          // Process complete SSE events in the buffer
          const parts = buffer.split('\n\n');
          buffer = parts.pop() || ''; // keep incomplete last chunk

          for (const part of parts) {
            const eventMatch = part.match(/^event:\s*(.+)$/m);
            const dataMatch = part.match(/^data:\s*(.+)$/m);
            if (!eventMatch || !dataMatch) continue;
            const eventType = eventMatch[1].trim();
            const payload = dataMatch[1];

            if (eventType === 'meta') {
              const meta = JSON.parse(payload);
              rawQuery = meta.rawQuery;
              if (meta.nodes?.length) {
                mergeGraphData(meta.nodes, meta.links || []);
                setSelectedNode(null);
              }
            } else if (eventType === 'token') {
              assistantText += JSON.parse(payload);
              const updatedText = assistantText;
              const updatedQuery = rawQuery;
              setMessages(prev => {
                const copy = [...prev];
                copy[copy.length - 1] = { role: 'assistant', text: updatedText, rawQuery: updatedQuery };
                return copy;
              });
            } else if (eventType === 'done') {
              const { highlightedIds: ids } = JSON.parse(payload);
              setHighlightedIds(new Set<string>(ids || []));
              setStreaming(false);
            }
          }
        }
      } else {
        // --- JSON fallback path (blocked queries, errors) ---
        const data = await res.json();
        setMessages(prev => [...prev, { role: 'assistant', text: data.reply, rawQuery: data.rawQuery }]);
        if (data.nodes?.length) {
          mergeGraphData(data.nodes, data.links || []);
          setSelectedNode(null);
        }
        setHighlightedIds(new Set<string>(data.highlightedIds || []));
      }
    } catch (err) {
      if ((err as Error)?.name !== 'AbortError') {
        setMessages(prev => [...prev, { role: 'assistant', text: 'Error contacting the server.' }]);
      }
    } finally {
      setLoading(false);
      setStreaming(false);
    }
  };

  const handleNodeClick = useCallback((node: GraphNode) => {
    setSelectedNode(node);
  }, []);

  const handleNodeRightClick = useCallback(async (node: GraphNode) => {
    const nodeId = (node.properties as any)?.id;
    if (!nodeId || !node.label || expanding) return;
    setExpanding(true);
    try {
      const res = await fetch('/api/expand', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ nodeId: String(nodeId), label: node.label }),
      });
      const data = await res.json();
      if (data.nodes?.length) {
        setGraphData(prev => {
          const existingNodeIds = new Set(prev.nodes.map(n => n.id));
          const existingLinkKeys = new Set(prev.links.map(l => `${typeof l.source === 'object' ? (l.source as any).id : l.source}-${l.type}-${typeof l.target === 'object' ? (l.target as any).id : l.target}`));
          const newNodes = data.nodes.filter((n: GraphNode) => !existingNodeIds.has(n.id));
          const newLinks = data.links.filter((l: GraphLink) => {
            const src = typeof l.source === 'object' ? (l.source as any).id : l.source;
            const tgt = typeof l.target === 'object' ? (l.target as any).id : l.target;
            const key = `${src}-${l.type}-${tgt}`;
            return !existingLinkKeys.has(key);
          });
          return {
            nodes: [...prev.nodes, ...newNodes],
            links: [...prev.links, ...newLinks],
          };
        });
      }
    } catch {
      setExpandError('Could not expand node. Please try again.');
      setTimeout(() => setExpandError(null), 3000);
    } finally {
      setExpanding(false);
    }
  }, [expanding]);

  return (
    <div className="flex h-screen overflow-hidden">
      <ChatSidebar
        messages={messages}
        input={input}
        loading={loading}
        streaming={streaming}
        onInputChange={setInput}
        onSend={sendMessage}
      />

      <div className="flex-1 relative bg-[#0f0f1a] overflow-hidden">
        <GraphCanvas
          graphData={graphData}
          selectedNodeId={selectedNode?.id ?? null}
          highlightedIds={highlightedIds}
          onNodeClick={handleNodeClick}
          onNodeRightClick={handleNodeRightClick}
        />
        <Legend expanding={expanding} />
        {expandError && (
          <div className="absolute bottom-5 left-1/2 -translate-x-1/2 bg-red-900/90 text-red-200 text-xs px-4 py-2 rounded-lg border border-red-700 pointer-events-none">
            {expandError}
          </div>
        )}
        {selectedNode && (
          <NodeInspector node={selectedNode} onClose={() => setSelectedNode(null)} />
        )}
      </div>
    </div>
  );
}
