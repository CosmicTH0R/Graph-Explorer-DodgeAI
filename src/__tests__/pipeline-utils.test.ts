import {
  escapeRegExp,
  compactValue,
  compactRecord,
  getMentionCandidates,
  isMutatingCypher,
} from '@/lib/pipeline-utils';

// ---------------------------------------------------------------------------
// escapeRegExp
// ---------------------------------------------------------------------------
describe('escapeRegExp', () => {
  it('leaves plain alphanumeric strings unchanged', () => {
    expect(escapeRegExp('90504274')).toBe('90504274');
    expect(escapeRegExp('SalesOrder')).toBe('SalesOrder');
  });

  it('escapes all regex special characters', () => {
    expect(escapeRegExp('a.b')).toBe('a\\.b');
    expect(escapeRegExp('a*b')).toBe('a\\*b');
    expect(escapeRegExp('a+b')).toBe('a\\+b');
    expect(escapeRegExp('a?b')).toBe('a\\?b');
    expect(escapeRegExp('(a)')).toBe('\\(a\\)');
    expect(escapeRegExp('[a]')).toBe('\\[a\\]');
    expect(escapeRegExp('{a}')).toBe('\\{a\\}');
    expect(escapeRegExp('a^b')).toBe('a\\^b');
    expect(escapeRegExp('a$b')).toBe('a\\$b');
    expect(escapeRegExp('a|b')).toBe('a\\|b');
    expect(escapeRegExp('a\\b')).toBe('a\\\\b');
  });

  it('produces patterns safe for use inside new RegExp()', () => {
    const id = '1.2.3';
    const safePattern = new RegExp(`\\b${escapeRegExp(id)}\\b`);
    // escaped dot is literal, so it matches the exact string as a whole word
    expect(safePattern.test('1.2.3')).toBe(true);
    // no word boundary when preceded by another word character
    expect(safePattern.test('x1.2.3')).toBe(false);
    const id2 = 'ABC-123';
    const safePattern2 = new RegExp(`\\b${escapeRegExp(id2)}\\b`);
    expect(safePattern2.test('prefix ABC-123 suffix')).toBe(true);
    expect(safePattern2.test('xABC-123x')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// compactValue
// ---------------------------------------------------------------------------
describe('compactValue', () => {
  it('passes through null and undefined', () => {
    expect(compactValue(null)).toBeNull();
    expect(compactValue(undefined)).toBeUndefined();
  });

  it('passes through scalars unchanged', () => {
    expect(compactValue(42)).toBe(42);
    expect(compactValue('hello')).toBe('hello');
    expect(compactValue(true)).toBe(true);
  });

  it('replaces arrays with a summary string', () => {
    expect(compactValue([1, 2, 3])).toBe('[array:3]');
    expect(compactValue([])).toBe('[array:0]');
    expect(compactValue(['a', 'b'])).toBe('[array:2]');
  });

  it('expands a top-level (depth=0) object, keeping scalar fields intact', () => {
    const result = compactValue({ id: '90000001', amount: 9802 }) as Record<string, unknown>;
    expect(result).toEqual({ id: '90000001', amount: 9802 });
  });

  it('compacts nested objects inside a top-level object to [object]', () => {
    const result = compactValue({ id: '1', nested: { x: 1 } }) as Record<string, unknown>;
    expect(result.id).toBe('1');
    expect(result.nested).toBe('[object]');
  });

  it('compacts nested arrays inside a top-level object', () => {
    const result = compactValue({ id: '1', items: [1, 2, 3] }) as Record<string, unknown>;
    expect(result.items).toBe('[array:3]');
  });

  it('replaces a plain object at depth > 0 with [object]', () => {
    expect(compactValue({ a: 1 }, 1)).toBe('[object]');
  });
});

// ---------------------------------------------------------------------------
// compactRecord
// ---------------------------------------------------------------------------
describe('compactRecord', () => {
  it('preserves scalar values at the record level', () => {
    const record = { nodeType: 'Customer', count: 5, active: true };
    expect(compactRecord(record)).toEqual({ nodeType: 'Customer', count: 5, active: true });
  });

  it('expands property objects one level deep', () => {
    // Simulates the case where obj[key] = value.properties from a Neo4j node
    const record = {
      c: { id: '320000083', salesOrg: 'DEMO' },
      relType: 'PLACES',
    };
    const result = compactRecord(record);
    expect(result.c).toEqual({ id: '320000083', salesOrg: 'DEMO' });
    expect(result.relType).toBe('PLACES');
  });

  it('compacts deeply nested objects inside property maps', () => {
    const record = {
      node: { id: '1', nested: { deep: true }, tags: ['a', 'b'] },
    };
    const result = compactRecord(record) as { node: Record<string, unknown> };
    expect(result.node.id).toBe('1');
    expect(result.node.nested).toBe('[object]');
    expect(result.node.tags).toBe('[array:2]');
  });
});

// ---------------------------------------------------------------------------
// getMentionCandidates
// ---------------------------------------------------------------------------
describe('getMentionCandidates', () => {
  it('always includes the id field', () => {
    const result = getMentionCandidates({ id: '90504274' });
    expect(result).toContain('90504274');
  });

  it('includes code and name fields', () => {
    const result = getMentionCandidates({ code: 'WH01', name: 'Berlin' });
    expect(result).toContain('WH01');
    expect(result).toContain('Berlin');
  });

  it('includes fields ending in Id, Code, Document', () => {
    const result = getMentionCandidates({
      soldToPartyId: 'C001',
      billingCode: 'BC99',
      accountingDocument: '9400000275',
    });
    expect(result).toContain('C001');
    expect(result).toContain('BC99');
    expect(result).toContain('9400000275');
  });

  it('includes values matching the strong uppercase pattern (4+ chars)', () => {
    const result = getMentionCandidates({ status: 'OPEN', type: 'ZFBR', misc: 'short' });
    expect(result).toContain('OPEN');
    expect(result).toContain('ZFBR');
    // 'short' does not match the uppercase pattern and its key is not in the allowlist
    expect(result).not.toContain('short');
  });

  it('skips null, array, and object values', () => {
    const result = getMentionCandidates({
      id: '1',
      nullField: null,
      arrField: [1, 2],
      objField: { x: 1 },
    });
    expect(result).toContain('1');
    expect(result).not.toContain('null');
    expect(result.length).toBe(1);
  });

  it('skips empty string values', () => {
    const result = getMentionCandidates({ id: '' });
    expect(result).toHaveLength(0);
  });

  it('deduplicates identical values across different matching keys', () => {
    const result = getMentionCandidates({ id: 'ABC123', code: 'ABC123' });
    expect(result.filter(v => v === 'ABC123').length).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// isMutatingCypher (read-only enforcement)
// ---------------------------------------------------------------------------
describe('isMutatingCypher', () => {
  const readOnly = [
    'MATCH (n:Customer) RETURN n',
    'MATCH (n)-[r]->(m) WHERE NOT n:Product RETURN n, r, m LIMIT 400',
    'MATCH (c:Customer)-[:PLACES]->(so:SalesOrder) WITH c, COUNT(DISTINCT so) AS cnt RETURN c, cnt ORDER BY cnt DESC LIMIT 10',
    // These look dangerous but are safe with word boundaries
    'MATCH (n) WHERE n.status = "RESET" RETURN n',
    'MATCH (n) RETURN n.offset AS OFFSET',
  ];

  const mutating = [
    'CREATE (n:Customer {id: "1"})',
    'MATCH (n) DELETE n',
    'MERGE (n:Customer {id: "1"})',
    'MATCH (n) SET n.name = "hack"',
    'MATCH (n) REMOVE n.name',
    'DROP INDEX ON :Customer(id)',
    'MATCH (n) DETACH DELETE n',
    'FOREACH (x IN [1] | CREATE (:Node {id: x}))',
    'CALL APOC.schema.assert({})',
    'LOAD CSV FROM "http://evil.com" AS row CREATE (:Node)',
    'CALL { MATCH (n) SET n.x = 1 }',
  ];

  test.each(readOnly)('allows read-only: %s', (query) => {
    expect(isMutatingCypher(query)).toBe(false);
  });

  test.each(mutating)('blocks mutating: %s', (query) => {
    expect(isMutatingCypher(query)).toBe(true);
  });

  it('is case-insensitive', () => {
    expect(isMutatingCypher('match (n) set n.x = 1')).toBe(true);
    expect(isMutatingCypher('Match (n) Create (:Node)')).toBe(true);
  });
});
