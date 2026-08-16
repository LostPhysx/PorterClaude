#!/usr/bin/env python3
"""List every file that survives .dockerignore, for building a Docker build context tar.

OWNER: O2. Spec: docs/design/orchestration.md 7.2. Stdlib only, python 3.9+.

usage:
    python3 deploy/lib/dockerignore.py --root . [--ignore-file .dockerignore] [--print0]

Prints repo-relative POSIX paths (one per line, or NUL separated with --print0) so that
    python3 deploy/lib/dockerignore.py --root . --print0 | tar --null -T - -cf ctx.tar -C .
produces the same context Docker would build.

.dockerignore semantics implemented here:
  * blank lines and lines starting with '#' are ignored
  * patterns are slash-separated, matched against the path relative to the context root
  * '*' matches within a segment, '**' matches any number of segments, '?' one character
  * a leading '!' negates a previous match (last matching rule wins)
  * a trailing '/' (or a pattern naming a directory) excludes the whole subtree: exclusion
    is inherited by children unless a later rule re-includes them explicitly
  * '.git' style bare names match at the root only; '**/node_modules' matches anywhere
"""
from __future__ import annotations

import argparse
import os
import posixpath
import re
import sys
from typing import Iterable, List, Optional, Tuple


def _compile(pattern: str) -> "re.Pattern[str]":
    """Translate a docker-style path pattern into an anchored regex."""
    out: List[str] = ["^"]
    i = 0
    n = len(pattern)
    while i < n:
        ch = pattern[i]
        if ch == "*":
            if i + 1 < n and pattern[i + 1] == "*":
                i += 2
                if i < n and pattern[i] == "/":
                    i += 1
                    out.append("(?:[^/]+/)*")       # '**/' = zero or more whole segments
                elif i >= n:
                    out.append(".*")                # trailing '**' = anything
                else:
                    out.append("[^/]*")             # degenerate 'a**b'
            else:
                out.append("[^/]*")
                i += 1
        elif ch == "?":
            out.append("[^/]")
            i += 1
        elif ch == "/":
            out.append("/")
            i += 1
        else:
            out.append(re.escape(ch))
            i += 1
    out.append("$")
    return re.compile("".join(out))


def _clean(pattern: str) -> str:
    """Normalise a pattern to a slash-separated, root-relative form without a trailing '/'."""
    p = pattern.replace("\\", "/").strip()
    while p.startswith("./"):
        p = p[2:]
    if p.startswith("/"):
        p = p.lstrip("/")
    while p.endswith("/"):
        p = p[:-1]
    return p


class DockerIgnore:
    """Compiled .dockerignore rule set."""

    def __init__(self, patterns: Iterable[str]) -> None:
        self.rules: List[Tuple[str, bool]] = []          # (cleaned pattern, negated)
        self._regexes: List[Tuple["re.Pattern[str]", bool]] = []
        for raw in patterns:
            line = raw.rstrip("\r\n")
            stripped = line.strip()
            if not stripped or stripped.startswith("#"):
                continue
            negated = stripped.startswith("!")
            if negated:
                stripped = stripped[1:].strip()
            cleaned = _clean(stripped)
            if not cleaned or cleaned == ".":
                continue
            self.rules.append((cleaned, negated))
            self._regexes.append((_compile(cleaned), negated))
        self.has_negations = any(neg for _, neg in self.rules)

    @classmethod
    def load(cls, path: str) -> "DockerIgnore":
        """Read a .dockerignore file; a missing file means 'ignore nothing'."""
        try:
            with open(path, "r", encoding="utf-8", errors="replace") as fh:
                return cls(fh.readlines())
        except FileNotFoundError:
            return cls([])

    def match(self, rel_path: str) -> Optional[bool]:
        """Last matching rule wins: True = excluded, False = re-included, None = no rule."""
        result: Optional[bool] = None
        for rx, negated in self._regexes:
            if rx.match(rel_path):
                result = not negated
        return result

    def ignored(self, rel_path: str, is_dir: bool = False) -> bool:
        """True when rel_path (POSIX, context-relative) is excluded.

        Ancestors are consulted so that excluding a directory excludes its subtree, while a
        later negation on a deeper path still wins.
        """
        rel_path = rel_path.strip("/")
        if not rel_path:
            return False
        parts = rel_path.split("/")
        excluded = False
        for depth in range(1, len(parts) + 1):
            prefix = "/".join(parts[:depth])
            verdict = self.match(prefix)
            if verdict is not None:
                excluded = verdict
        _ = is_dir  # directory-ness only matters for pruning, handled by walk_context
        return excluded

    def may_contain_exception(self, rel_dir: str) -> bool:
        """True when a negation rule could re-include something below an excluded dir."""
        if not self.has_negations:
            return False
        depth = len(rel_dir.strip("/").split("/")) if rel_dir.strip("/") else 0
        for pattern, negated in self.rules:
            if not negated:
                continue
            if "**" in pattern:
                return True
            head = "/".join(pattern.split("/")[:depth]) if depth else ""
            if not head:
                return True
            if _compile(head).match(rel_dir.strip("/")):
                return True
        return False


def walk_context(root: str, ig: DockerIgnore) -> List[str]:
    """os.walk the tree, pruning ignored directories, returning surviving relative paths.

    Deterministic (sorted) so a repeated run produces an identical tar.
    """
    root = os.path.abspath(root)
    files: List[str] = []

    def descend(abs_dir: str, rel_dir: str, parent_excluded: bool) -> None:
        try:
            entries = sorted(os.scandir(abs_dir), key=lambda e: e.name)
        except OSError as exc:  # unreadable directory: warn, keep going
            print("warning: cannot read %s (%s)" % (rel_dir or ".", exc), file=sys.stderr)
            return
        for entry in entries:
            rel = posixpath.join(rel_dir, entry.name) if rel_dir else entry.name
            try:
                is_dir = entry.is_dir(follow_symlinks=False)
            except OSError:
                is_dir = False
            verdict = ig.match(rel)
            excluded = parent_excluded if verdict is None else verdict
            if is_dir:
                if excluded and not ig.may_contain_exception(rel):
                    continue
                descend(entry.path, rel, excluded)
            else:
                if not excluded:
                    files.append(rel)

    descend(root, "", False)
    files.sort()
    return files


def main(argv: Optional[List[str]] = None) -> int:
    ap = argparse.ArgumentParser(description="list files surviving .dockerignore")
    ap.add_argument("--root", default=".")
    ap.add_argument("--ignore-file", default=".dockerignore")
    ap.add_argument("--print0", action="store_true")
    args = ap.parse_args(argv)

    root = os.path.abspath(args.root)
    if not os.path.isdir(root):
        print("error: --root %s is not a directory" % args.root, file=sys.stderr)
        return 2
    ignore_file = args.ignore_file
    if not os.path.isabs(ignore_file):
        ignore_file = os.path.join(root, ignore_file)
    ig = DockerIgnore.load(ignore_file)

    sep = "\0" if args.print0 else "\n"
    out = sys.stdout
    for rel in walk_context(root, ig):
        out.write(rel + sep)
    out.flush()
    return 0


if __name__ == "__main__":
    sys.exit(main())
