#!/usr/bin/env python3
"""Portainer/Docker JSON helpers for deploy/deploy.sh (no jq dependency).

OWNER: O2. Spec: docs/design/orchestration.md §7.2. Stdlib only, python 3.9+.
This module NEVER reads or prints the API key: deploy.sh keeps it in a curl config file.

subcommands:
  build-stream                      stdin = the JSON-lines body of POST /docker/build;
                                    prints `stream`/`status` values as they arrive,
                                    exits 1 on `error` / `errorDetail`
  find-stack --name N --endpoint E  stdin = GET /api/stacks response; prints the matching
                                    stack Id (case-insensitive name, endpoint filtered) or
                                    nothing; exit 0 either way
  stack-body --file F --name N [--env VAR]...
                                    prints the JSON body for stack create/update:
                                    {"name":…, "stackFileContent":<file>,
                                     "env":[{"name":VAR,"value":os.environ[VAR]}, …]}
                                    --legacy switches to the capitalised legacy field names
"""
from __future__ import annotations

import argparse
import sys
from typing import List


def cmd_build_stream(stream) -> int:
    """Print docker build progress line by line; return 1 on an error entry. TODO(O2)

    Docker emits one JSON object per line: {"stream":"Step 1/9 : FROM ..."} and, on failure,
    {"errorDetail":{"message":"..."},"error":"..."}. Non-JSON lines are printed verbatim.
    """
    raise NotImplementedError("TODO(O2)")


def cmd_find_stack(stream, name: str, endpoint: str) -> int:
    """Print the id of the stack called `name` on `endpoint`, or nothing. TODO(O2)"""
    raise NotImplementedError("TODO(O2)")


def cmd_stack_body(path: str, name: str, env_names: List[str], legacy: bool) -> int:
    """Print the JSON create/update body (json.dumps — never string concatenation). TODO(O2)"""
    raise NotImplementedError("TODO(O2)")


def main(argv: List[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="Portainer JSON helpers")
    sub = ap.add_subparsers(dest="cmd", required=True)
    sub.add_parser("build-stream")
    p_find = sub.add_parser("find-stack")
    p_find.add_argument("--name", required=True)
    p_find.add_argument("--endpoint", required=True)
    p_body = sub.add_parser("stack-body")
    p_body.add_argument("--file", required=True)
    p_body.add_argument("--name", required=True)
    p_body.add_argument("--env", action="append", default=[])
    p_body.add_argument("--legacy", action="store_true")
    args = ap.parse_args(argv)
    # TODO(O2): dispatch to the cmd_* functions above
    raise NotImplementedError("TODO(O2)")


if __name__ == "__main__":
    sys.exit(main())
