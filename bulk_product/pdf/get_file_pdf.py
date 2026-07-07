"""
Fetch all PDF files from Shopify Files and export to Excel.
Output: output/pdf_files.xlsx
Columns: file_name, url

Usage:
    py get_file_pdf.py
    py get_file_pdf.py --output output/pdf_files.xlsx
"""
import sys, os as _os
sys.path.insert(0, _os.path.dirname(_os.path.dirname(_os.path.abspath(__file__))))

import os
import sys
import argparse
import pandas as pd
from utils import make_headers, gql, API_URL

# Requires a token with 'read_files' scope.
HEADERS    = make_headers("SHOPIFY_ACCESS_TOKEN_CREATE_PRODUCT")
OUTPUT_DIR = os.path.join(os.path.dirname(__file__), "output")
OUTPUT_FILE = os.path.join(OUTPUT_DIR, "pdf_files.xlsx")

QUERY = """
query getFiles($cursor: String) {
  files(first: 250, after: $cursor, query: "media_type:GENERIC_FILE") {
    pageInfo { hasNextPage endCursor }
    edges {
      node {
        ... on GenericFile {
          id
          url
          mimeType
          originalFileSize
          createdAt
        }
      }
    }
  }
}
"""


def fetch_pdf_files() -> list[dict]:
    rows   = []
    cursor = None
    while True:
        body = gql(API_URL, HEADERS, QUERY, {"cursor": cursor})
        if not body:
            break
        data      = body["data"]["files"]
        edges     = data["edges"]
        page_info = data["pageInfo"]
        for edge in edges:
            node = edge["node"]
            # Skip nodes that don't match GenericFile (empty dict from other types)
            if not node:
                continue
            mime = node.get("mimeType") or ""
            url  = node.get("url") or ""
            if mime != "application/pdf" and not url.lower().endswith(".pdf"):
                continue
            # Extract file name from URL
            file_name = url.split("?")[0].split("/")[-1] if url else ""
            rows.append({
                "file_name": file_name,
                "url":       url,
            })
        if not page_info["hasNextPage"]:
            break
        cursor = page_info["endCursor"]
    return rows


def main(output_path: str):
    os.makedirs(os.path.dirname(output_path), exist_ok=True)
    print("Fetching PDF files from Shopify...")
    rows = fetch_pdf_files()
    if not rows:
        print("No PDF files found.")
        return
    df = pd.DataFrame(rows, columns=["file_name", "url"])
    df.to_excel(output_path, index=False)
    print(f"Exported {len(df)} PDF file(s) -> {output_path}")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Export Shopify PDF files to Excel")
    parser.add_argument("--output", default=OUTPUT_FILE, help="Output Excel file path")
    args = parser.parse_args()
    main(args.output)
