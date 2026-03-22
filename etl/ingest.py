
import json
import glob
from neo4j import GraphDatabase
import os
from dotenv import load_dotenv

# ==========================================
# 1. DATABASE CONFIGURATION
# ==========================================
# Load credentials from .env file
load_dotenv(os.path.join(os.path.dirname(__file__), '..', '.env'))
NEO4J_URI = os.getenv("NEO4J_URI")
NEO4J_USER = os.getenv("NEO4J_USERNAME")
NEO4J_PASSWORD = os.getenv("NEO4J_PASSWORD")

# ==========================================
# 2. DATA PARSING LOGIC
# ==========================================
def parse_files(file_pattern="*.jsonl"):
    """Reads JSONL files and routes data into node and edge lists.

    Record-type detection order (most-specific first):
      1. Product master data          – has 'product', no doc keys
      2. Billing Document Item        – has 'billingDocument' + 'billingDocumentItem'
      3. Billing Document Header      – has 'billingDocument' + 'billingDocumentType'
      4. Delivery Document Item       – has 'deliveryDocument'/'outboundDelivery' + 'deliveryDocumentItem'
      5. Delivery Document Header     – has 'deliveryDocument'/'outboundDelivery', no item key
      6. Sales Order Item             – has 'salesOrder' + 'salesOrderItem' + 'material'
      7. Sales Order Header           – has 'salesOrder' + 'salesOrderType'
      8. Journal Entry (item)         – has 'accountingDocument' + 'glAccount'
      9. Customer master data         – has 'businessPartner'
    """
    nodes = {
        "Customer": [], "SalesOrder": [], "DeliveryDocument": [],
        "BillingDocument": [], "JournalEntry": [], "Product": []
    }
    edges = []

    files = glob.glob(file_pattern)
    print(f"Found {len(files)} files to process...")

    for file in files:
        with open(file, 'r') as f:
            for line in f:
                if not line.strip():
                    continue
                record = json.loads(line)

                has_billing   = 'billingDocument'   in record
                has_delivery  = 'deliveryDocument'  in record or 'outboundDelivery' in record
                has_so        = 'salesOrder'        in record

                # --- 1. Product master ---
                if 'product' in record and not has_billing and not has_delivery and not has_so:
                    nodes["Product"].append({"id": record['product'], "props": record})

                # --- 2. Billing Document Item ---
                # (referenceSdDocument in item → the delivery document that was billed)
                elif has_billing and 'billingDocumentItem' in record:
                    doc_id = record['billingDocument']
                    mat = record.get('material')
                    ref = record.get('referenceSdDocument') or record.get('referenceDocument')

                    if mat:
                        # BillingDocument -[:CONTAINS_ITEM]-> Product
                        edges.append({"from_type": "BillingDocument", "from_id": doc_id,
                                      "to_type": "Product",           "to_id": mat,
                                      "rel_type": "CONTAINS_ITEM_BD"})
                        nodes["Product"].append({"id": mat, "props": {"id": mat}})

                    if ref:
                        # DeliveryDocument -[:BILLED_IN]-> BillingDocument
                        edges.append({"from_type": "DeliveryDocument", "from_id": ref,
                                      "to_type": "BillingDocument",   "to_id": doc_id,
                                      "rel_type": "BILLED_IN"})

                # --- 3. Billing Document Header ---
                elif has_billing and 'billingDocumentType' in record:
                    doc_id = record['billingDocument']
                    nodes["BillingDocument"].append({"id": doc_id, "props": record})

                    if record.get('soldToParty'):
                        cust_id = record['soldToParty']
                        edges.append({"from_type": "Customer",         "from_id": cust_id,
                                      "to_type": "BillingDocument",   "to_id": doc_id,
                                      "rel_type": "BILLED_TO"})
                        nodes["Customer"].append({"id": cust_id, "props": {"id": cust_id}})

                    if record.get('accountingDocument'):
                        je_id = record['accountingDocument']
                        edges.append({"from_type": "BillingDocument", "from_id": doc_id,
                                      "to_type": "JournalEntry",      "to_id": je_id,
                                      "rel_type": "ACCOUNTED_IN"})
                        nodes["JournalEntry"].append({"id": je_id, "props": {"id": je_id}})

                # --- 4. Delivery Document Item ---
                # (referenceSdDocument → the SalesOrder that generated this delivery)
                elif has_delivery and 'deliveryDocumentItem' in record:
                    doc_id = record.get('deliveryDocument') or record.get('outboundDelivery')
                    ref = record.get('referenceSdDocument') or record.get('referenceDocument')

                    if ref:
                        # SalesOrder -[:GENERATES]-> DeliveryDocument
                        edges.append({"from_type": "SalesOrder",      "from_id": ref,
                                      "to_type": "DeliveryDocument",  "to_id": doc_id,
                                      "rel_type": "GENERATES"})

                # --- 5. Delivery Document Header ---
                elif has_delivery:
                    doc_id = record.get('deliveryDocument') or record.get('outboundDelivery')
                    nodes["DeliveryDocument"].append({"id": doc_id, "props": record})

                # --- 6. Sales Order Item ---
                elif has_so and 'salesOrderItem' in record and 'material' in record:
                    so_id = record['salesOrder']
                    mat   = record['material']
                    # SalesOrder -[:CONTAINS_ITEM]-> Product
                    edges.append({"from_type": "SalesOrder", "from_id": so_id,
                                  "to_type": "Product",      "to_id": mat,
                                  "rel_type": "CONTAINS_ITEM_SO"})
                    nodes["Product"].append({"id": mat, "props": {"id": mat}})

                # --- 7. Sales Order Header ---
                elif has_so and 'salesOrderType' in record:
                    doc_id = record['salesOrder']
                    nodes["SalesOrder"].append({"id": doc_id, "props": record})

                    cust_id = record.get('soldToParty') or record.get('customer')
                    if cust_id:
                        edges.append({"from_type": "Customer",    "from_id": cust_id,
                                      "to_type": "SalesOrder",   "to_id": doc_id,
                                      "rel_type": "PLACES"})

                # --- 8. Journal Entry (line item with glAccount) ---
                elif 'accountingDocument' in record and 'glAccount' in record:
                    doc_id = record['accountingDocument']
                    nodes["JournalEntry"].append({"id": doc_id, "props": record})

                # --- 9. Customer master data ---
                elif 'businessPartner' in record:
                    nodes["Customer"].append({"id": record['businessPartner'], "props": record})

    return nodes, edges

# ==========================================
# 3. NEO4J INGESTION LOGIC
# ==========================================
def sanitize_props(props: dict) -> dict:
    """
    Neo4j only supports primitive types (str, int, float, bool) and arrays of
    primitives as node properties.  Any nested dict/list-of-dicts is converted
    to a JSON string so it can still be stored without crashing the ingestion.
    """
    clean = {}
    for key, value in props.items():
        if value is None:
            continue  # skip nulls
        elif isinstance(value, (str, int, float, bool)):
            clean[key] = value
        elif isinstance(value, list):
            # Keep lists of primitives; serialise everything else
            if all(isinstance(v, (str, int, float, bool)) for v in value):
                clean[key] = value
            else:
                clean[key] = json.dumps(value)
        elif isinstance(value, dict):
            clean[key] = json.dumps(value)
        else:
            clean[key] = str(value)
    return clean

def create_constraints(tx):
    """Constraints ensure we don't create duplicate nodes and speeds up MERGE."""
    labels = ["Customer", "SalesOrder", "DeliveryDocument", "BillingDocument", "JournalEntry", "Product"]
    for label in labels:
        try:
            tx.run(f"CREATE CONSTRAINT IF NOT EXISTS FOR (n:{label}) REQUIRE n.id IS UNIQUE")
        except Exception as e:
            pass # Constraint might already exist

def ingest_nodes(tx, label, data):
    """Uses UNWIND for bulk insert (Fast and scalable)"""
    if not data: return
    # Sanitize props so only Neo4j-compatible primitives are sent
    clean_data = [{"id": row["id"], "props": sanitize_props(row["props"])} for row in data]
    query = f"""
    UNWIND $batch AS row
    MERGE (n:{label} {{id: row.id}})
    SET n += row.props
    """
    tx.run(query, batch=clean_data)

def ingest_edges(session, data):
    """
    Groups edges by rel_type and runs one typed Cypher query per group.
    This avoids dynamic relationship types (which require APOC) and the
    CALL { WITH ... WHERE } pattern that is invalid in newer Cypher.
    """
    if not data: return

    # Templates keyed by rel_type.  Each query uses explicit node labels
    # so Neo4j can use the unique-id indexes for fast MATCH.
    queries = {
        "PLACES": """
            UNWIND $batch AS row
            MATCH (a:Customer {id: row.from_id})
            MATCH (b:SalesOrder {id: row.to_id})
            MERGE (a)-[:PLACES]->(b)
        """,
        "GENERATES": """
            UNWIND $batch AS row
            MATCH (a:SalesOrder {id: row.from_id})
            MATCH (b:DeliveryDocument {id: row.to_id})
            MERGE (a)-[:GENERATES]->(b)
        """,
        "BILLED_IN": """
            UNWIND $batch AS row
            MATCH (a:DeliveryDocument {id: row.from_id})
            MATCH (b:BillingDocument {id: row.to_id})
            MERGE (a)-[:BILLED_IN]->(b)
        """,
        "BILLED_TO": """
            UNWIND $batch AS row
            MATCH (a:Customer {id: row.from_id})
            MATCH (b:BillingDocument {id: row.to_id})
            MERGE (a)-[:BILLED_TO]->(b)
        """,
        "ACCOUNTED_IN": """
            UNWIND $batch AS row
            MATCH (a:BillingDocument {id: row.from_id})
            MATCH (b:JournalEntry {id: row.to_id})
            MERGE (a)-[:ACCOUNTED_IN]->(b)
        """,
        "CONTAINS_ITEM_SO": """
            UNWIND $batch AS row
            MATCH (a:SalesOrder {id: row.from_id})
            MERGE (b:Product {id: row.to_id})
            MERGE (a)-[:CONTAINS_ITEM]->(b)
        """,
        "CONTAINS_ITEM_BD": """
            UNWIND $batch AS row
            MATCH (a:BillingDocument {id: row.from_id})
            MERGE (b:Product {id: row.to_id})
            MERGE (a)-[:CONTAINS_ITEM]->(b)
        """,
    }

    # Group edges by rel_type
    from collections import defaultdict
    grouped = defaultdict(list)
    for edge in data:
        grouped[edge["rel_type"]].append({"from_id": edge["from_id"], "to_id": edge["to_id"]})

    for rel_type, batch in grouped.items():
        if rel_type not in queries:
            print(f"  ! Skipping unknown rel_type: {rel_type}")
            continue
        session.run(queries[rel_type], batch=batch)
        print(f"  -> Linked {len(batch)} [{rel_type}] edges")


# ==========================================
# 4. EXECUTION
# ==========================================
if __name__ == "__main__":
    print("Parsing JSONL files...")
    nodes_dict, edges_list = parse_files("data/*.jsonl")
    
    print("\nData Parsed. Summary:")
    for entity, data in nodes_dict.items():
        print(f"- {entity}: {len(data)} nodes")
    print(f"- Total Edges: {len(edges_list)}")
    # Show edge type breakdown
    from collections import Counter
    edge_counts = Counter(e["rel_type"] for e in edges_list)
    for rel, cnt in sorted(edge_counts.items()):
        print(f"  {rel}: {cnt}")

    print("\nConnecting to Neo4j...")
    driver = GraphDatabase.driver(NEO4J_URI, auth=(NEO4J_USER, NEO4J_PASSWORD))

    with driver.session() as session:
        # 1. Setup DB Schema
        print("Creating constraints...")
        session.execute_write(create_constraints)
        
        # 2. Upload Nodes
        print("Uploading Nodes...")
        for label, data in nodes_dict.items():
            if data:
                session.execute_write(ingest_nodes, label, data)
                print(f"  -> Uploaded {label} ({len(data)} records, deduped by MERGE)")
                
        # 3. Upload Edges
        print("Uploading Edges...")
        ingest_edges(session, edges_list)
        print("  -> All edges linked.")

    driver.close()
    print("\nDone! Database is up to date.")
    print("\n✅ ETL Pipeline Complete! Data is now a Graph.")