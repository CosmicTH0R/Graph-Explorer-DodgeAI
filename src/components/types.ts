export interface GraphNode {
  id: string;
  label: string;
  properties: Record<string, unknown>;
  x?: number;
  y?: number;
}

export interface GraphLink {
  source: string;
  target: string;
  type: string;
}

export interface Message {
  role: 'user' | 'assistant';
  text: string;
  rawQuery?: string;
}

export const LABEL_COLOURS: Record<string, string> = {
  Customer:         '#60a5fa',
  SalesOrder:       '#34d399',
  DeliveryDocument: '#fbbf24',
  BillingDocument:  '#f87171',
  JournalEntry:     '#a78bfa',
  Address:          '#f472b6',
};

export const defaultColour = '#94a3b8';
