#!/usr/bin/env python3
"""List every file that survives .dockerignore, for building a Docker build context tar.

OWNER: O2. Spec: docs/design/orchestration.md §7.2. Stdlib only, python 3.9+.

usage:
    python3 deploy/lib/dockerignore.py --root . [--ignore-file .dockerignore] [--print0]

Prints repo-relative POSIX paths (one per line, or NUL separated with --print0) so that
    python3 deploy/lib/dockerignore.py --root . --print0 | tar --null -T - -cf ctx.tar -C .
produces the same context Docker would build.

.dockerignore semantics to implement:
  * blank lines and lines starting with '#' are ignored
  * patterns are slash-separated, matched against the path relative to the context root
  * '*' matches within a segment, '**' matches any number of segments, '?' one character
  * a leading '!' negates a previous match (last matching rule wins)
  * a trailing '/' (or a pattern naming a directory) excludes the whole subtree
  * '.git' style bare names match at the root only; '**/node_modules' matches anywhere
"""
from __future__ import annotations

import argparse
import sys
from typing import Iterable, List


class DockerIgnore:
    """Compiled .dockerignore rule set."""

    def __init__(self, patterns: Iterable[str]) -> None:
        self.rules: List[tuple[str, bool]] = []  # (pattern, negated)
        # TODO(O2): normalise, drop comments/blanks, record negations

    @classmethod
    def load(cls, path: str) -> "DockerIgnore":
        """Read a .dockerignore file; a missing file means 'ignore nothing'. TODO(O2)"""
        raise NotImplementedError("TODO(O2)")

    def ignored(self, rel_path: str, is_dir: bool = False) -> bool:
        """True when rel_path (POSIX, context-relative) is excluded. Last match wins. TODO(O2)"""
        raise NotImplementedError("TODO(O2)")


def walk_context(root: str, ig: DockerIgnore) -> List[str]:
    """os.walk the tree, pruning ignored directories, returning surviving relative paths.

    Must be deterministic (sorted) so a repeated run produces an identical tar. TODO(O2)
    """
    raise NotImplementedError("TODO(O2)")


def main(argv: List[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="list files surviving .dockerignore")
    ap.add_argument("--root", default=".")
    ap.add_argument("--ignore-file", default=".dockerignore")
    ap.add_argument("--print0", action="store_true")
    args = ap.parse_args(argv)
    # TODO(O2): ig = DockerIgnore.load(...); for p in walk_context(...): print(p, end=sep)
    raise NotImplementedError("TODO(O2)")


if __name__ == "__main__":
    sys.exit(main())
