"""Refresh the DB랜드 fallback snapshot from an approved local network."""
from __future__ import annotations

import base64
import gzip
import json
import math
import time
import argparse
from datetime import datetime, timedelta, timezone
from pathlib import Path

import requests


ROOT = Path(__file__).resolve().parents[1]
OUTPUT = ROOT / "automation" / "dbland_snapshot.json.gz.b64"
KST = timezone(timedelta(hours=9))
session = requests.Session()
session.headers.update({
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126 Safari/537.36",
    "Referer": "https://db-land.kr/archive/place/021302/1",
    "X-Requested-With": "XMLHttpRequest",
})


def page(number: int) -> tuple[list[dict], int]:
    response = session.post(
        "https://db-land.kr/archive/proc/get_list.php",
        data={"type": "place", "sch_ca_id": "021302", "itemsPerPage": 50, "currentPage": number},
        timeout=45,
    )
    response.raise_for_status()
    payload = response.json()
    rows = []
    for item in payload.get("data", []):
        try:
            registered = datetime.fromtimestamp(int(item["reg_time"]) + 86400, KST).replace(tzinfo=None)
        except (KeyError, TypeError, ValueError, OSError):
            continue
        rows.append({
            "date": registered.isoformat(),
            "name": str(item.get("company") or ""),
            "phone": str(item.get("phone") or item.get("tel") or ""),
            "address": str(item.get("address") or ""),
            "page": number,
        })
    return rows, int(payload.get("totalCount") or 0)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--recent-pages", type=int, default=0)
    args = parser.parse_args()
    first, total = page(1)
    rows = first
    pages = math.ceil(total / 50)
    pages_to_fetch = min(pages, args.recent_pages) if args.recent_pages else pages
    for number in range(2, pages_to_fetch + 1):
        current, _ = page(number)
        rows.extend(current)
        if number % 10 == 0 or number == pages_to_fetch:
            print(f"DB랜드 {number}/{pages_to_fetch} 페이지")
        time.sleep(0.12)
    if args.recent_pages and OUTPUT.exists():
        previous = json.loads(gzip.decompress(base64.b64decode(OUTPUT.read_text(encoding="ascii"))).decode("utf-8"))
        cutoff = min(item["date"] for item in rows)
        rows.extend(item for item in previous.get("rows", []) if item.get("date", "") < cutoff)
        seen: set[tuple[str, str, str, str]] = set()
        rows = [item for item in rows if not (key := (item.get("date", ""), item.get("name", ""), item.get("phone", ""), item.get("address", ""))) in seen and not seen.add(key)]
    payload = {"totalCount": total, "refreshedAt": datetime.now(KST).isoformat(), "rows": rows}
    encoded = base64.b64encode(gzip.compress(json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8"))).decode("ascii")
    OUTPUT.write_text(encoded, encoding="ascii")
    print(f"DB랜드 스냅샷 갱신: {len(rows)}건 / {pages_to_fetch}페이지")


if __name__ == "__main__":
    main()
