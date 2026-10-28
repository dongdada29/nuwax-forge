#!/usr/bin/env python3
"""校验仓内配方的结构化证据；不执行验收命令。"""
import argparse
import json
import sys
from task_state import validate_verification


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--manifest", required=True)
    p.add_argument("--repo", required=True)
    p.add_argument("--level")
    p.add_argument("--predicate", action="append", default=[])
    p.add_argument("--node", help="显式可信 node 运行器；缺省回退 PATH")
    args = p.parse_args()
    try:
        data = validate_verification(args.manifest, args.repo, args.predicate, args.level, args.node)
    except (ValueError, OSError, KeyError, TypeError) as error:
        print(json.dumps({"passed": False, "failure": str(error)}, ensure_ascii=False))
        return 1
    print(json.dumps({"passed": True, "recipe": data["recipe"], "level": data["level"],
                      "inputDigest": data["source"]["inputDigest"],
                      "predicates": [p["id"] for p in data["predicates"]]}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
