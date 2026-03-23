'use client';

import { useState, useCallback } from 'react';
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
  const [highlightedIds, setHighlightedIds] = useState<Set<string>>(new Set());

  const sendMessage = async () => {
    const text = input.trim();
    if (!text || loading) return;
    setInput('');
    setLoading(true);
    setMessages(prev => [...prev, { role: 'user', text }]);

    const recentHistory = [...messages, { role: 'user' as const, text }]
      .slice(-10)
      .map(m => ({ role: m.role, text: m.text }));

    try {
      const res = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: text, history: recentHistory }),
      });

      const contentType = res.headers.get('content-type') || '';

      if (contentType.includes('text/event-stream')) {
        // --- SSE streaming path ---
        let rawQuery: string | undefined;
        let assistantText = '';
        // Add a placeholder assistant message that we'll update progressively
        setMessages(prev => [...prev, { role: 'assistant', text: '' }]);

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
                setGraphData({ nodes: meta.nodes, links: meta.links || [] });
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
            }
          }
        }
      } else {
        // --- JSON fallback path (blocked queries, errors) ---
        const data = await res.json();
        setMessages(prev => [...prev, { role: 'assistant', text: data.reply, rawQuery: data.rawQuery }]);
        if (data.nodes?.length) {
          setGraphData({ nodes: data.nodes, links: data.links || [] });
          setSelectedNode(null);
        }
        setHighlightedIds(new Set<string>(data.highlightedIds || []));
      }
    } catch {
      setMessages(prev => [...prev, { role: 'assistant', text: 'Error contacting the server.' }]);
    } finally {
      setLoading(false);
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
            const key = `${l.source}-${l.type}-${l.target}`;
            return !existingLinkKeys.has(key);
          });
          return {
            nodes: [...prev.nodes, ...newNodes],
            links: [...prev.links, ...newLinks],
          };
        });
      }
    } catch {
      // silently ignore expand errors
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
        {selectedNode && (
          <NodeInspector node={selectedNode} onClose={() => setSelectedNode(null)} />
        )}
      </div>
    </div>
  );
}
