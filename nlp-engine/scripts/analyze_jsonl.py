import argparse
import json
import sys
from pathlib import Path

import httpx


def main() -> int:
    parser = argparse.ArgumentParser(description="Run local GLiNER2.5 extraction over the rolling-window JSONL dataset.")
    parser.add_argument("--input", default="../data/output/posts-365d.jsonl")
    parser.add_argument("--output", default="../data/output/enriched-posts.jsonl")
    parser.add_argument("--endpoint", default="http://127.0.0.1:8010/v1/analyze")
    parser.add_argument("--domain", choices=["tic", "aspire_lifestyle"], required=True)
    parser.add_argument("--limit", type=int, default=0, help="Optional maximum number of records for a smoke test.")
    args = parser.parse_args()

    root = Path(__file__).resolve().parents[2]
    input_path = (Path.cwd() / args.input).resolve()
    output_path = (Path.cwd() / args.output).resolve()
    if not input_path.exists():
        print(f"Input file not found: {input_path}", file=sys.stderr)
        return 2

    output_path.parent.mkdir(parents=True, exist_ok=True)
    processed = set()
    if output_path.exists():
        with output_path.open("r", encoding="utf-8") as handle:
            for line in handle:
                try:
                    old = json.loads(line)
                    source = old.get("sourcePost", {})
                    processed.add(str(source.get("postId", "")))
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
                    if post_id in processed:
                        skipped += 1
                        continue
                    payload = {
                        "post_id": post_id,
                        "tracked_competitor": post["trackedCompetitor"],
                        "author_username": post.get("authorUsername"),
                        "domain_id": args.domain,
                        "text": post.get("text") or " ",
                        "source_url": post.get("url"),
                        "created_at": post.get("createdAt"),
                        "conversation_root_id": post.get("conversationRootId")
                    }
                    response = client.post(args.endpoint, json=payload)
                    response.raise_for_status()
                    result = response.json()
                    result["sourceRecord"] = post
                    output_file.write(json.dumps(result, ensure_ascii=False) + "\n")
                    output_file.flush()
                    processed.add(post_id)
                    count += 1
                    print(f"Processed {post_id} ({count} new)")
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
