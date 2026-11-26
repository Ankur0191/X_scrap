import argparse
import json
import sys
from pathlib import Path

import httpx


def main() -> int:
    repo_root = Path(__file__).resolve().parents[2]
    parser = argparse.ArgumentParser(description="Run local GLiNER2.5 extraction over the rolling-window JSONL dataset.")
    parser.add_argument("--input", default="data/output/conversation-365d.jsonl")
    parser.add_argument("--output", default="data/output/enriched-posts.jsonl")
    parser.add_argument("--endpoint", default="http://127.0.0.1:8010/v1/analyze")
    parser.add_argument("--domain", choices=["tic", "aspire_lifestyle"], default=None,
                        help="Optional override. Normally the competitor's domainId in config/competitors.json is used.")
    parser.add_argument("--limit", type=int, default=0, help="Optional maximum number of new records for a smoke test.")
    args = parser.parse_args()

    def resolve_path(value: str) -> Path:
        path = Path(value)
        return path if path.is_absolute() else (repo_root / path).resolve()

    input_path = resolve_path(args.input)
    output_path = resolve_path(args.output)
    config_path = repo_root / "config" / "competitors.json"
    if not input_path.exists():
        print(f"Input file not found: {input_path}", file=sys.stderr)
        return 2

    with config_path.open("r", encoding="utf-8") as handle:
        config = json.load(handle)
    domain_map = {
        str(item["username"]).replace("@", "").lower(): item.get("domainId")
        for item in config.get("competitors", [])
    }

    output_path.parent.mkdir(parents=True, exist_ok=True)
    processed = set()
    if output_path.exists():
        with output_path.open("r", encoding="utf-8") as handle:
            for line in handle:
                try:
                    old = json.loads(line)
                    # Current output stores the original row in sourceRecord;
                    # sourcePost is accepted for compatibility with older outputs.
                    source = old.get("sourceRecord") or old.get("sourcePost") or {}
                    tracked = str(source.get("trackedCompetitor", "")).replace("@", "").lower()
                    source_post_id = source.get("id") or source.get("postId")
                    if tracked and source_post_id:
                        processed.add(tracked + ":" + str(source_post_id))
                except json.JSONDecodeError:
                    continue

    count = 0
    skipped = 0
    errors = 0
    with input_path.open("r", encoding="utf-8") as source_file, output_path.open("a", encoding="utf-8") as output_file:
        with httpx.Client(timeout=180.0) as client:
            for line_number, line in enumerate(source_file, start=1):
                if not line.strip():
                    continue
                try:
                    post = json.loads(line)
                    post_id = str(post["id"])
                    tracked_competitor = str(post["trackedCompetitor"]).replace("@", "").lower()
                    dedupe_key = tracked_competitor + ":" + post_id
                    if dedupe_key in processed:
                        skipped += 1
                        continue
                    domain_id = args.domain or domain_map.get(tracked_competitor)
                    if domain_id not in {"tic", "aspire_lifestyle"}:
                        raise ValueError(f"No valid domainId configured for competitor {tracked_competitor}")
                    payload = {
                        "post_id": post_id,
                        "tracked_competitor": tracked_competitor,
                        "author_username": post.get("authorUsername"),
                        "domain_id": domain_id,
                        "text": post.get("text") or " ",
                        "source_url": post.get("url"),
                        "created_at": post.get("createdAt"),
                        "conversation_root_id": post.get("conversationRootId"),
                        "parent_post_id": post.get("parentPostId"),
                        "is_thread_reply": bool(post.get("isThreadReply"))
                    }
                    response = client.post(args.endpoint, json=payload)
                    response.raise_for_status()
                    result = response.json()
                    result["sourceRecord"] = post
                    output_file.write(json.dumps(result, ensure_ascii=False) + "\n")
                    output_file.flush()
                    processed.add(dedupe_key)
                    count += 1
                    print(f"Processed {tracked_competitor}:{post_id} using {domain_id} ({count} new)")
                    if args.limit and count >= args.limit:
                        break
                except Exception as exc:
                    errors += 1
                    error_record = {"line": line_number, "error": str(exc)}
                    print(json.dumps(error_record, ensure_ascii=False), file=sys.stderr)

    print(json.dumps({
        "newlyProcessed": count,
        "alreadyProcessed": skipped,
        "errors": errors,
        "output": str(output_path)
    }, indent=2))
    return 1 if errors else 0


if __name__ == "__main__":
    raise SystemExit(main())
