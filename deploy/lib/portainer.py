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
  stack-body --file F --name N [--env VAR]... [--update] [--legacy] [--pull]
                                    prints the JSON body for stack create/update:
                                    {"name":..., "stackFileContent":<file>,
                                     "env":[{"name":VAR,"value":os.environ[VAR]}, ...]}
                                    --update swaps in the update shape
                                    ({"stackFileContent","env","prune":true,
                                      "pullImage":false}) and --legacy the capitalised
                                    field names of the pre-2.x create endpoint.
                                    --pull sets pullImage:true, for a stack that points at
                                    a registry image instead of one just built on the engine
  json-get --path A.B.0.C          stdin = any JSON; prints the value at that dotted path
                                    (list indices allowed), nothing when it is absent
  filter-containers [--name-prefix P]... [--label K[=V]]...
                                    stdin = GET /containers/json?all=1; prints one
                                    `id<TAB>name<TAB>state` line per container matching ALL
                                    given label filters and ANY of the name prefixes
  filter-images [--label-prefix P] stdin = GET /images/json?filters=dangling; prints one
                                    `id<TAB>sizeBytes<TAB>labels` line per image carrying at
                                    least one label whose key starts with P
  find-container --match S [--match S]...
                                    stdin = GET /containers/json?all=1; prints
                                    `id<TAB>name` of the first container whose name or image
                                    contains one of the substrings
  mount-source --dest D            stdin = GET /containers/<id>/json; prints the HOST path
                                    bind-mounted at D inside that container (the leading
                                    slash of D is optional — leave it off under Git Bash,
                                    which would rewrite it into a Windows path)
  mount-volumes [--prefix P]...    stdin = GET /containers/<id>/json; prints the NAME of
                                    every named volume the container mounts, one per line,
                                    restricted to the given name prefixes when any is given
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
                   update: bool = False, pull: bool = False) -> int:
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
        body = {"stackFileContent": content, "env": env, "prune": True, "pullImage": bool(pull)}
    elif legacy:
        body = {"Name": name, "StackFileContent": content, "Env": env}
    else:
        body = {"name": name, "stackFileContent": content, "env": env}
    sys.stdout.write(json.dumps(body))
    return 0


# ---------------------------------------------------------------------------------------
# small read-only helpers for deploy.sh / host-prep.sh (no jq on the reference boxes)
# ---------------------------------------------------------------------------------------

def _load(stream) -> Any:
    try:
        return json.load(stream)
    except ValueError as exc:
        sys.stderr.write("error: expected JSON on stdin (%s)\n" % exc)
        return None


def _dig(data: Any, path: str) -> Any:
    """Walk a dotted path; integer segments index into lists."""
    cur = data
    for part in path.split("."):
        if part == "":
            continue
        if isinstance(cur, dict):
            if part not in cur:
                return None
            cur = cur[part]
        elif isinstance(cur, list):
            try:
                cur = cur[int(part)]
            except (ValueError, IndexError):
                return None
        else:
            return None
    return cur


def cmd_json_get(stream, path: str) -> int:
    data = _load(stream)
    if data is None:
        return 0
    value = _dig(data, path)
    if value is None:
        return 0
    if isinstance(value, (dict, list)):
        sys.stdout.write(json.dumps(value))
    else:
        sys.stdout.write(str(value))
    return 0


def _container_names(container: Dict[str, Any]) -> List[str]:
    names = container.get("Names") or container.get("names") or []
    if isinstance(names, str):
        names = [names]
    return [str(n).lstrip("/") for n in names if n]


def _labels(obj: Dict[str, Any]) -> Dict[str, str]:
    labels = obj.get("Labels") or obj.get("labels") or {}
    return {str(k): str(v) for k, v in labels.items()} if isinstance(labels, dict) else {}


def cmd_filter_containers(stream, prefixes: List[str], label_filters: List[str]) -> int:
    """Print `id<TAB>name<TAB>state` for containers matching every label and any prefix."""
    data = _load(stream)
    if not isinstance(data, list):
        return 0
    wanted: List[tuple] = []
    for raw in label_filters:
        key, sep, value = str(raw).partition("=")
        wanted.append((key.strip(), value.strip() if sep else None))
    for container in data:
        if not isinstance(container, dict):
            continue
        labels = _labels(container)
        if any(key not in labels or (val is not None and labels[key] != val)
               for key, val in wanted):
            continue
        names = _container_names(container)
        if prefixes and not any(n.startswith(p) for n in names for p in prefixes):
            continue
        cid = str(container.get("Id") or container.get("id") or "")
        if not cid:
            continue
        sys.stdout.write("%s\t%s\t%s\n" % (cid, names[0] if names else cid[:12],
                                             container.get("State") or "?"))
    return 0


def cmd_filter_images(stream, label_prefix: str) -> int:
    """Print `id<TAB>sizeBytes<TAB>labels` for images carrying a label with that prefix."""
    data = _load(stream)
    if not isinstance(data, list):
        return 0
    for image in data:
        if not isinstance(image, dict):
            continue
        labels = _labels(image)
        hits = {k: v for k, v in labels.items() if not label_prefix or k.startswith(label_prefix)}
        if not hits:
            continue
        iid = str(image.get("Id") or image.get("id") or "")
        if not iid:
            continue
        summary = ",".join("%s=%s" % (k, v) for k, v in sorted(hits.items()))
        sys.stdout.write("%s\t%s\t%s\n" % (iid, image.get("Size") or 0, summary))
    return 0


def cmd_find_container(stream, matches: List[str]) -> int:
    """Print `id<TAB>name` of the first container whose name or image contains a substring."""
    data = _load(stream)
    if not isinstance(data, list):
        return 0
    needles = [m.lower() for m in matches if m]
    for container in data:
        if not isinstance(container, dict):
            continue
        names = _container_names(container)
        haystack = " ".join(names + [str(container.get("Image") or "")]).lower()
        if any(n in haystack for n in needles):
            cid = str(container.get("Id") or container.get("id") or "")
            if cid:
                sys.stdout.write("%s\t%s\n" % (cid, names[0] if names else cid[:12]))
                return 0
    return 0


def cmd_mount_source(stream, dest: str) -> int:
    """Print the host path bind-mounted at `dest` inside an inspected container.

    The leading slash of `dest` is optional, and callers running under Git Bash on Windows
    should leave it off: MSYS rewrites an argument that looks like an absolute POSIX path
    into a Windows path before it ever reaches (native) python.
    """
    data = _load(stream)
    if not isinstance(data, dict):
        return 0
    mounts = data.get("Mounts") or []
    if not isinstance(mounts, list):
        return 0
    wanted = "/" + dest.strip("/")
    for mount in mounts:
        if not isinstance(mount, dict):
            continue
        if str(mount.get("Destination") or "").rstrip("/") != wanted:
            continue
        source = mount.get("Source") or mount.get("Name") or ""
        if source:
            sys.stdout.write(str(source))
            return 0
    return 0


def cmd_mount_volumes(stream, prefixes: List[str]) -> int:
    """Print the named volumes a container mounts (optionally only those with a prefix).

    Removing a container with `v=1` only drops its ANONYMOUS volumes; the workspace and
    history volumes PorterClaude creates are named, so a cleanup has to collect them from
    the container spec before the container disappears.
    """
    data = _load(stream)
    if not isinstance(data, dict):
        return 0
    mounts = data.get("Mounts") or []
    if not isinstance(mounts, list):
        return 0
    seen = set()
    for mount in mounts:
        if not isinstance(mount, dict):
            continue
        if str(mount.get("Type") or "") != "volume":
            continue
        name = str(mount.get("Name") or "")
        if not name or name in seen:
            continue
        if prefixes and not any(name.startswith(p) for p in prefixes):
            continue
        seen.add(name)
        sys.stdout.write(name + "\n")
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
    p_body.add_argument("--pull", action="store_true",
                        help="pullImage:true — the stack points at a registry image")
    p_get = sub.add_parser("json-get")
    p_get.add_argument("--path", required=True)
    p_fc = sub.add_parser("filter-containers")
    p_fc.add_argument("--name-prefix", action="append", default=[])
    p_fc.add_argument("--label", action="append", default=[])
    p_fi = sub.add_parser("filter-images")
    p_fi.add_argument("--label-prefix", default="")
    p_find = sub.add_parser("find-container")
    p_find.add_argument("--match", action="append", default=[], required=True)
    p_mount = sub.add_parser("mount-source")
    p_mount.add_argument("--dest", required=True)
    p_vols = sub.add_parser("mount-volumes")
    p_vols.add_argument("--prefix", action="append", default=[])
    args = ap.parse_args(argv)

    if args.cmd == "build-stream":
        return cmd_build_stream(sys.stdin,
                                require_success=not args.allow_missing_marker)
    if args.cmd == "find-stack":
        return cmd_find_stack(sys.stdin, args.name, args.endpoint)
    if args.cmd == "stack-body":
        return cmd_stack_body(args.file, args.name, args.env, args.legacy, args.update,
                              args.pull)
    if args.cmd == "json-get":
        return cmd_json_get(sys.stdin, args.path)
    if args.cmd == "filter-containers":
        return cmd_filter_containers(sys.stdin, args.name_prefix, args.label)
    if args.cmd == "filter-images":
        return cmd_filter_images(sys.stdin, args.label_prefix)
    if args.cmd == "find-container":
        return cmd_find_container(sys.stdin, args.match)
    if args.cmd == "mount-source":
        return cmd_mount_source(sys.stdin, args.dest)
    if args.cmd == "mount-volumes":
        return cmd_mount_volumes(sys.stdin, args.prefix)
    ap.error("unknown command")
    return 2


if __name__ == "__main__":
    sys.exit(main())
