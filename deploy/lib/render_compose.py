#!/usr/bin/env python3
"""Render deploy/docker-compose.yml with environment substitution (envsubst equivalent).

OWNER: O2. Spec: docs/design/orchestration.md §7.2. Stdlib only, python 3.9+.

usage:
    python3 deploy/lib/render_compose.py deploy/docker-compose.yml \
        --keep APP_PASSWORD --out deploy/.build/stack.yml

Rules:
  * ${VAR} and ${VAR:-default} are substituted from os.environ
  * names listed in --keep (comma separated) are left LITERAL — deploy.sh hands those to
    Portainer through the stack `env` array instead, so secrets are not baked into the file
  * an unset variable with no default is a hard error (exit 2) naming the variable: a silently
    empty VIRTUAL_HOST would deploy an unreachable stack
  * $$ escapes a literal $ (compose convention); leave $VAR without braces untouched
"""
from __future__ import annotations

import argparse
import sys
from typing import Iterable, List


class MissingVariable(Exception):
    """Raised for ${VAR} with no value and no default."""


def render(text: str, env: dict, keep: Iterable[str]) -> str:
    """Substitute ${VAR} / ${VAR:-default}; leave `keep` names alone. TODO(O2)"""
    raise NotImplementedError("TODO(O2)")


def main(argv: List[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="render a compose file with env substitution")
    ap.add_argument("file")
    ap.add_argument("--keep", default="", help="comma separated variable names to leave literal")
    ap.add_argument("--out", default="-")
    args = ap.parse_args(argv)
    # TODO(O2): read file, render, write to --out (or stdout); MissingVariable -> exit 2
    raise NotImplementedError("TODO(O2)")


if __name__ == "__main__":
    sys.exit(main())
