#!/usr/bin/env python3
"""
Simple USPTO Design Patent search CLI.

Usage examples:
  python design_patent_search.py --keyword "wireless earbuds" --limit 20
  python design_patent_search.py --assignee "Apple" --keyword "phone" --after 2020-01-01
  python design_patent_search.py --keyword "smartwatch" --json

Environment:
  USPTO_ODP_API_KEY=<your_uspto_key>
"""

import argparse
import json
import os
import sys
import urllib.error
import urllib.request


API_URL = "https://api.uspto.gov/api/v1/patent/applications/search"


def build_query(keyword: str, assignee: str) -> str:
    # Force design-only scope.
    clauses = ['applicationMetaData.applicationTypeLabelName:Design']
    if keyword:
        clauses.append(f'({keyword})')
    if assignee:
        clauses.append(f'({assignee})')
    return " AND ".join(clauses)


def post_search(api_key: str, q: str, limit: int, after: str, before: str) -> dict:
    body = {
        "q": q,
        "pagination": {"offset": 0, "limit": limit},
    }
    if after or before:
        body["rangeFilters"] = [
            {
                "field": "applicationMetaData.filingDate",
                "valueFrom": after or "1900-01-01",
                "valueTo": before or "2099-12-31",
            }
        ]

    data = json.dumps(body).encode("utf-8")
    req = urllib.request.Request(
        API_URL,
        data=data,
        method="POST",
        headers={
            "Content-Type": "application/json",
            "Accept": "application/json",
            "X-API-KEY": api_key,
            "User-Agent": "codex-design-patent-search/1.0",
        },
    )
    with urllib.request.urlopen(req, timeout=30) as resp:
        return json.loads(resp.read().decode("utf-8", errors="replace"))


def fmt(val: str) -> str:
    return (val or "").strip()


def print_table(resp: dict) -> None:
    rows = resp.get("patentFileWrapperDataBag", []) or []
    total = resp.get("count", len(rows))
    print(f"Total matched: {total}")
    print(f"Returned: {len(rows)}")
    print("")
    print("PatentNo | FilingDate | Assignee | Title")
    print("-" * 120)
    for item in rows:
        meta = item.get("applicationMetaData", {}) or {}
        patent_no = fmt(meta.get("patentNumber")) or "-"
        filing_date = fmt(meta.get("filingDate")) or "-"
        assignee = fmt(meta.get("applicantBag")) or fmt(meta.get("assigneeEntityName")) or "-"
        title = fmt(meta.get("inventionTitle")) or "-"
        if len(title) > 80:
            title = title[:77] + "..."
        print(f"{patent_no} | {filing_date} | {assignee} | {title}")


def main() -> int:
    parser = argparse.ArgumentParser(description="Search USPTO design patents only")
    parser.add_argument("--keyword", default="", help="Keyword for product appearance")
    parser.add_argument("--assignee", default="", help="Company/brand name")
    parser.add_argument("--limit", type=int, default=25, help="Max records to return")
    parser.add_argument("--after", default="", help="Filing date from (YYYY-MM-DD)")
    parser.add_argument("--before", default="", help="Filing date to (YYYY-MM-DD)")
    parser.add_argument("--json", action="store_true", help="Print raw JSON")
    args = parser.parse_args()

    api_key = os.getenv("USPTO_ODP_API_KEY", "").strip()
    if not api_key:
        print(
            "Missing USPTO_ODP_API_KEY.\n"
            "Set it first, then rerun.\n"
            "PowerShell example:\n"
            "  $env:USPTO_ODP_API_KEY = \"your_key_here\"",
            file=sys.stderr,
        )
        return 2

    q = build_query(args.keyword, args.assignee)
    try:
        resp = post_search(
            api_key=api_key,
            q=q,
            limit=args.limit,
            after=args.after,
            before=args.before,
        )
    except urllib.error.HTTPError as e:
        detail = ""
        try:
            detail = e.read().decode("utf-8", errors="replace")
        except Exception:
            detail = str(e)
        print(f"HTTP {e.code}: {detail}", file=sys.stderr)
        return 1
    except Exception as e:
        print(f"Request failed: {e}", file=sys.stderr)
        return 1

    if args.json:
        print(json.dumps(resp, ensure_ascii=False, indent=2))
    else:
        print_table(resp)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

