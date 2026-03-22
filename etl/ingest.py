
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
    """Reads JSONL files and routes data into node and edge lists."""
    nodes = {
        "Customer": [], "SalesOrder": [], "DeliveryDocument": [], 
        "BillingDocument": [], "JournalEntry": []
    }
    edges = []

    files = glob.glob(file_pattern)
    print(f"Found {len(files)} files to process...")

    for file in files:
        with open(file, 'r') as f:
            for line in f:
                if not line.strip(): continue
                record = json.loads(line)
                
                # --- IDENTIFY ENTITY AND EXTRACT ---
                # 1. Billing Document
                if 'billingDocument' in record and 'billingDocumentType' in record:
                    doc_id = record['billingDocument']
                    nodes["BillingDocument"].append({"id": doc_id, "props": record})
                    
                    # Edges for Billing
                    if record.get('soldToParty'):
                        edges.append({"from_type": "Customer", "from_id": record['soldToParty'], 
                                      "to_type": "BillingDocument", "to_id": doc_id, "rel_type": "BILLED_TO"})
                        # Create implicit customer node if it doesn't exist fully
                        nodes["Customer"].append({"id": record['soldToParty'], "props": {"id": record['soldToParty']}})
                        
                    if record.get('accountingDocument'):
                        edges.append({"from_type": "BillingDocument", "from_id": doc_id, 
                                      "to_type": "JournalEntry", "to_id": record['accountingDocument'], "rel_type": "ACCOUNTED_IN"})
                        # Implicit Journal node
                        nodes["JournalEntry"].append({"id": record['accountingDocument'], "props": {"id": record['accountingDocument']}})

                    if record.get('referenceDocument'): # Often points to Delivery or Order
                         edges.append({"from_type": "DeliveryDocument", "from_id": record['referenceDocument'], 
                                      "to_type": "BillingDocument", "to_id": doc_id, "rel_type": "BILLED_IN"})

                # 2. Delivery Document
                elif 'deliveryDocument' in record or 'outboundDelivery' in record:
                    doc_id = record.get('deliveryDocument') or record.get('outboundDelivery')
                    nodes["DeliveryDocument"].append({"id": doc_id, "props": record})
                    
                    if record.get('salesOrder') or record.get('referenceDocument'):
                        ref_id = record.get('salesOrder') or record.get('referenceDocument')
                        edges.append({"from_type": "SalesOrder", "from_id": ref_id, 
                                      "to_type": "DeliveryDocument", "to_id": doc_id, "rel_type": "GENERATES"})

                # 3. Sales Order
                elif 'salesOrder' in record:
                    doc_id = record['salesOrder']
                    nodes["SalesOrder"].append({"id": doc_id, "props": record})
                    
                    if record.get('soldToParty') or record.get('customer'):
                        cust_id = record.get('soldToParty') or record.get('customer')
                        edges.append({"from_type": "Customer", "from_id": cust_id, 
                                      "to_type": "SalesOrder", "to_id": doc_id, "rel_type": "PLACES"})

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
    labels = ["Customer", "SalesOrder", "DeliveryDocument", "BillingDocument", "JournalEntry"]
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
                print(f"  -> Uploaded {label}")
                
        # 3. Upload Edges
        print("Uploading Edges...")
        ingest_edges(session, edges_list)
        print("  -> All edges linked.")

    driver.close()
    print("\n✅ ETL Pipeline Complete! Data is now a Graph.")