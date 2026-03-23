'use client';

import { useRef, useEffect } from 'react';
import { Message } from './types';

interface ChatSidebarProps {
  messages: Message[];
  input: string;
  loading: boolean;
  onInputChange: (value: string) => void;
  onSend: () => void;
}

export default function ChatSidebar({ messages, input, loading, onInputChange, onSend }: ChatSidebarProps) {
  const chatEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => { chatEndRef.current?.scrollIntoView({ behavior: 'smooth' }); }, [messages]);

  return (
    <div className="w-[380px] min-w-[320px] flex flex-col bg-[#1a1a2e] border-r border-[#2d2d4e]">
      {/* Header */}
      <div className="px-5 py-4 border-b border-[#2d2d4e] bg-[#16213e]">
        <h1 className="text-lg font-bold text-blue-400">🔍 Graph Explorer</h1>
        <p className="text-xs text-slate-500 mt-0.5">Ask questions · Right-click a node to expand</p>
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
          onChange={e => onInputChange(e.target.value)}
          onKeyDown={e => e.key === 'Enter' && onSend()}
          placeholder="Ask about orders, billing…"
          disabled={loading}
          className="flex-1 px-3.5 py-2.5 rounded-[10px] border border-[#2d2d4e] bg-[#0f172a] text-slate-200 text-sm outline-none focus:border-blue-500 transition-colors"
        />
        <button
          onClick={onSend}
          disabled={loading || !input.trim()}
          className={`px-4 py-2.5 rounded-[10px] border-none text-slate-200 text-sm font-semibold transition-colors ${
            loading || !input.trim() ? 'bg-slate-800 cursor-default' : 'bg-blue-600 cursor-pointer hover:bg-blue-500'
          }`}
        >
          Send
        </button>
      </div>
    </div>
  );
}
