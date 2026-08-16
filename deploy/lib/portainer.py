#!/usr/bin/env python3
"""Portainer/Docker JSON helpers for deploy/deploy.sh (no jq dependency).

OWNER: O2. Spec: docs/design/orchestration.md 7.2. Stdlib only, python 3.9+.
This module NEVER reads or prints the API key: deploy.sh keeps it in a curl config file.

subcommands:
  build-stream [--allow-missing-marker]
                                    stdin = the JSON-lines body of POST /docker/build;
                                    prints `stream`/`status` values as they arrive.
                                    Exits 1 on `error` / `errorDetail`, on a top-level
                                    Portainer/proxy error object ({"message": ...}), on a
                                    body that is not Docker JSON at all (an nginx 502/504
                                    HTML page), on an empty body, and on a stream that ends
                                    without a success marker (`aux.ID` /
                                    `Successfully built|tagged` / buildkit `writing image`).
                                    Only an explicit --allow-missing-marker relaxes that
                                    last rule; success is never inferred from silence.
  find-stack --name N --endpoint E  stdin = GET /api/stacks response; prints the matching
                                    stack Id (case-insensitive name, endpoint filtered) or
                                    nothing; exit 0 either way
  stack-body --file F --name N [--env VAR]... [--update] [--legacy]
                                    prints the JSON body for stack create/update:
                                    {"name":..., "stackFileContent":<file>,
                                     "env":[{"name":VAR,"value":os.environ[VAR]}, ...]}
                                    --update swaps in the update shape
                                    ({"stackFileContent","env","prune":true,
                                      "pullImage":false}) and --legacy the capitalised
                                    field names of the pre-2.x create endpoint
"""
from __future__ import annotations

import argparse
import json
import os
import sys
from typing import Any, Dict, List, Optional


def _iter_json_objects(stream):
    """Yield (obj, raw) for every JSON value in a stream that may pack several per line."""
    decoder = json.JSONDecoder()
    buf = ""
    for chunk in iter(lambda: stream.readline(), ""):
        buf += chunk
        while buf:
            stripped = buf.lstrip()
            if not stripped:
                buf = ""
                break
            offset = len(buf) - len(stripped)
            try:
                obj, end = decoder.raw_decode(stripped)
            except ValueError:
                if "\n" in buf:
                    line, buf = buf.split("\n", 1)
                    if line.strip():
                        yield None, line.rstrip("\r")
                    continue
                break                    # incomplete value: wait for more input
            buf = buf[offset + end:]
            yield obj, None
    tail = buf.strip()
    if tail:
        yield None, tail


# A build only counts as successful when the daemon says so. The classic builder ends with
# `Successfully built <id>` / `Successfully tagged <ref>` plus an `aux` object carrying the
# image id; buildkit ends with `writing image sha256:...`. Anything else (a Portainer error
# object, an nginx 502/504 HTML page, an empty body, a stream cut short by a proxy timeout)
# must fail, otherwise deploy.sh would happily ship a stale image.
_SUCCESS_MARKERS = (
    "successfully built",     # classic builder
    "successfully tagged",    # classic builder, with -t
    "writing image sha256:",  # buildkit
)


def _looks_successful(text: str) -> bool:
    low = text.lower()
    return any(marker in low for marker in _SUCCESS_MARKERS)


def _error_object_message(obj: Dict[str, Any]) -> Optional[str]:
    """Return the message of a Portainer/proxy error object, or None if it is build output.

    Portainer answers non-2xx with {"message": ..., "details": ...}; Docker build output
    never carries a bare top-level `message`, so such an object means the build never ran.
    """
    if "message" not in obj:
        return None
    if any(key in obj for key in ("stream", "status", "aux", "progressDetail", "progress")):
        return None
    message = str(obj.get("message") or "").strip() or "request rejected"
    details = obj.get("details")
    if isinstance(details, str) and details.strip():
        message = "%s (%s)" % (message, details.strip())
    return message


def cmd_build_stream(stream, require_success: bool = True) -> int:
    """Print docker build progress line by line.

    Returns 0 only when the stream actually reported a finished image; every other shape
    (docker error entry, Portainer error object, HTML/plain-text proxy page, empty body,
    truncated stream) returns 1, so the caller never mistakes junk for a successful build.
    """
    status = 0
    saw_json = False       # at least one decoded JSON value
    saw_output = False     # any bytes at all
    saw_success = False    # an explicit success marker
    out = sys.stdout
    for obj, raw in _iter_json_objects(stream):
        if obj is None:
            if raw:
                saw_output = True
                out.write(raw + "\n")
                out.flush()
            continue
        saw_output = True
        saw_json = True
        if not isinstance(obj, dict):
            out.write(str(obj) + "\n")
            out.flush()
            continue
        if "error" in obj or "errorDetail" in obj:
            detail = obj.get("errorDetail") or {}
            message = ""
            if isinstance(detail, dict):
                message = str(detail.get("message") or "")
            if not message:
                message = str(obj.get("error") or "build failed")
            sys.stderr.write("build error: " + message.rstrip() + "\n")
            sys.stderr.flush()
            status = 1
            continue
        api_error = _error_object_message(obj)
        if api_error is not None:
            sys.stderr.write("build error: the endpoint rejected the request: "
                             + api_error + "\n")
            sys.stderr.flush()
            status = 1
            continue
        text = obj.get("stream")
        if isinstance(text, str):
            if _looks_successful(text):
                saw_success = True
            out.write(text if text.endswith("\n") else text + "\n")
            out.flush()
            continue
        text = obj.get("status")
        if isinstance(text, str):
            if _looks_successful(text):
                saw_success = True
            progress = obj.get("progress")
            ident = obj.get("id")
            line = text
            if ident:
                line = "%s %s" % (ident, line)
            if isinstance(progress, str) and progress:
                line = "%s %s" % (line, progress)
            out.write(line.rstrip() + "\n")
            out.flush()
            continue
        aux = obj.get("aux")
        if isinstance(aux, dict) and (aux.get("ID") or aux.get("Digest")):
            saw_success = True
            out.write("image: %s\n" % (aux.get("ID") or aux.get("Digest")))
            out.flush()
    if status == 0 and not saw_success and require_success:
        if not saw_output:
            reason = "the build endpoint returned an empty body"
        elif not saw_json:
            reason = ("the build endpoint did not return Docker JSON output "
                      "(proxy error page or timeout?)")
        else:
            reason = ("the build stream ended without a success marker "
                      "(no image id, no 'Successfully built')")
        sys.stderr.write("build error: %s\n" % reason)
        sys.stderr.flush()
        status = 1
    return status


def _stack_endpoint_id(stack: Dict[str, Any]) -> Optional[str]:
    for key in ("EndpointId", "EndpointID", "endpointId", "endpointID"):
        if key in stack and stack[key] is not None:
            return str(stack[key])
    return None


def cmd_find_stack(stream, name: str, endpoint: str) -> int:
    """Print the id of the stack called `name` on `endpoint`, or nothing."""
    try:
        data = json.load(stream)
    except ValueError as exc:
        sys.stderr.write("error: /api/stacks did not return JSON (%s)\n" % exc)
        return 0
    if isinstance(data, dict):
        data = data.get("stacks") or data.get("Stacks") or []
    if not isinstance(data, list):
        return 0
    wanted = name.strip().lower()
    for stack in data:
        if not isinstance(stack, dict):
            continue
        stack_name = str(stack.get("Name") or stack.get("name") or "").strip().lower()
        if stack_name != wanted:
            continue
        eid = _stack_endpoint_id(stack)
        if endpoint and eid is not None and eid != str(endpoint).strip():
            continue
        sid = stack.get("Id", stack.get("id"))
        if sid is not None:
            sys.stdout.write(str(sid))
            return 0
    return 0


def _env_array(env_names: List[str]) -> List[Dict[str, str]]:
    out: List[Dict[str, str]] = []
    for raw in env_names:
        for part in str(raw).split(","):
            var = part.strip()
            if not var:
                continue
            out.append({"name": var, "value": os.environ.get(var, "")})
    return out


def cmd_stack_body(path: str, name: str, env_names: List[str], legacy: bool,
                   update: bool = False) -> int:
    """Print the JSON create/update body (json.dumps - never string concatenation)."""
    try:
        with open(path, "r", encoding="utf-8") as fh:
            content = fh.read()
    except OSError as exc:
        sys.stderr.write("error: cannot read %s: %s\n" % (path, exc))
        return 2
    env = _env_array(env_names)
    body: Dict[str, Any]
    if update:
        body = {"stackFileContent": content, "env": env, "prune": True, "pullImage": False}
    elif legacy:
        body = {"Name": name, "StackFileContent": content, "Env": env}
    else:
        body = {"name": name, "stackFileContent": content, "env": env}
    sys.stdout.write(json.dumps(body))
    return 0


def main(argv: Optional[List[str]] = None) -> int:
    ap = argparse.ArgumentParser(description="Portainer JSON helpers")
    sub = ap.add_subparsers(dest="cmd", required=True)
    p_build = sub.add_parser("build-stream")
    p_build.add_argument("--allow-missing-marker", action="store_true",
                         help="print the stream but do not require a success marker "
                              "(diagnostics only — deploy.sh never uses this)")
    p_find = sub.add_parser("find-stack")
    p_find.add_argument("--name", required=True)
    p_find.add_argument("--endpoint", required=True)
    p_body = sub.add_parser("stack-body")
    p_body.add_argument("--file", required=True)
    p_body.add_argument("--name", required=True)
    p_body.add_argument("--env", action="append", default=[])
    p_body.add_argument("--legacy", action="store_true")
    p_body.add_argument("--update", action="store_true")
    args = ap.parse_args(argv)

    if args.cmd == "build-stream":
        return cmd_build_stream(sys.stdin,
                                require_success=not args.allow_missing_marker)
    if args.cmd == "find-stack":
        return cmd_find_stack(sys.stdin, args.name, args.endpoint)
    if args.cmd == "stack-body":
        return cmd_stack_body(args.file, args.name, args.env, args.legacy, args.update)
    ap.error("unknown command")
    return 2


if __name__ == "__main__":
    sys.exit(main())
