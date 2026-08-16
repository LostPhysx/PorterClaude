#!/usr/bin/env python3
"""Render deploy/docker-compose.yml with environment substitution (envsubst equivalent).

OWNER: O2. Spec: docs/design/orchestration.md 7.2. Stdlib only, python 3.9+.

usage:
    python3 deploy/lib/render_compose.py deploy/docker-compose.yml \
        --keep APP_PASSWORD --out deploy/.build/stack.yml

Rules:
  * ${VAR} and ${VAR:-default} are substituted from os.environ
    (${VAR-default} is also accepted: that default applies only when VAR is unset, while
     :- also applies when VAR is set but empty)
  * names listed in --keep (comma or space separated) are left LITERAL - deploy.sh hands
    those to Portainer through the stack `env` array instead, so secrets are not baked into
    the rendered file
  * an unset variable with no default is a hard error (exit 2) naming the variable: a
    silently empty VIRTUAL_HOST would deploy an unreachable stack
  * `$$` is the compose escape for a literal `$` and is passed through untouched, as is a
    bare `$VAR` without braces (compose/docker interpret those at runtime)
"""
from __future__ import annotations

import argparse
import os
import re
import sys
from typing import Dict, Iterable, List, Optional, Set

# $$ (compose escape) or ${NAME} / ${NAME:-default} / ${NAME-default}
_VAR_RE = re.compile(r"\$\$|\$\{([A-Za-z_][A-Za-z0-9_]*)(?:(:?-)([^{}]*))?\}")


class MissingVariable(Exception):
    """Raised for ${VAR} with no value and no default."""


def render(text: str, env: Dict[str, str], keep: Iterable[str]) -> str:
    """Substitute ${VAR} / ${VAR:-default}; leave `keep` names alone."""
    keep_set: Set[str] = {k for k in keep if k}
    missing: List[str] = []

    def repl(m: "re.Match[str]") -> str:
        if m.group(0) == "$$":
            return "$$"                          # compose escape: pass through verbatim
        name, sep, default = m.group(1), m.group(2), m.group(3)
        if name in keep_set:
            return m.group(0)                    # secret: delivered via the stack env array
        value = env.get(name)
        if value is None or (value == "" and sep == ":-"):
            if sep is not None:
                return default or ""
            missing.append(name)
            return m.group(0)
        return value

    out = _VAR_RE.sub(repl, text)
    if missing:
        uniq = sorted(set(missing))
        raise MissingVariable(
            "no value and no default for: " + ", ".join("${%s}" % n for n in uniq)
        )
    return out


def _split_keep(value: str) -> List[str]:
    return [part for chunk in value.split(",") for part in chunk.split() if part]


def main(argv: Optional[List[str]] = None) -> int:
    ap = argparse.ArgumentParser(description="render a compose file with env substitution")
    ap.add_argument("file")
    ap.add_argument("--keep", default="", help="comma separated variable names to leave literal")
    ap.add_argument("--out", default="-")
    args = ap.parse_args(argv)

    try:
        with open(args.file, "r", encoding="utf-8") as fh:
            text = fh.read()
    except OSError as exc:
        print("error: cannot read %s: %s" % (args.file, exc), file=sys.stderr)
        return 2

    try:
        rendered = render(text, dict(os.environ), _split_keep(args.keep))
    except MissingVariable as exc:
        print("error: %s (%s)" % (exc, args.file), file=sys.stderr)
        return 2

    if args.out == "-":
        sys.stdout.write(rendered)
        sys.stdout.flush()
        return 0
    out_dir = os.path.dirname(os.path.abspath(args.out))
    if out_dir:
        os.makedirs(out_dir, exist_ok=True)
    with open(args.out, "w", encoding="utf-8", newline="\n") as fh:
        fh.write(rendered)
    return 0


if __name__ == "__main__":
    sys.exit(main())
