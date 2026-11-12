#!/usr/bin/env python3
"""Structure indexer for Python source, one batch of files per process.

The kernel must never execute the repository it analyses, so this script only
ever calls ``ast.parse``: nothing here compiles, imports or runs a target file.
Parsing is the whole job, and a parser is exactly the thing that works on code
that has never been installed or that does not even import.

Why a long-lived process talking NDJSON over stdin: interpreter startup costs
50-80 ms, which is invisible for one file and fatal for a 5 000-file tree. The
parent therefore spawns one child per run and feeds it file paths.

Protocol, one JSON object per line in each direction:

    in   {"type": "index", "files": ["/abs/path.py", ...]}
    out  {"path": .., "imports": [{"specifier": .., "level": N}],
          "symbols": [{"name": .., "kind": .., "line": ..}], "error": null}
    in   {"type": "exit"}

Exactly one reply line per requested file, in request order. A file that cannot
be read or parsed is a reply with ``error`` set: one broken file must never take
the sidecar, and with it the rest of the repository, down.
"""

import ast
import io
import json
import sys
import tokenize

BOM = b'\xef\xbb\xbf'

# `try:` has two spellings from 3.11 on (`except*`). Both are dependency-hiding
# constructs, so both are descended into when they span Python versions.
TRY_TYPES = tuple(
    kind for kind in (getattr(ast, 'Try', None), getattr(ast, 'TryStar', None)) if kind is not None
)


def decode(path):
    """The text of `path`, honouring a BOM and a PEP 263 encoding cookie.

    `tokenize.detect_encoding` is the standard's own answer to "how is this file
    encoded": it reads the cookie and the BOM exactly as the interpreter would.
    Decoding still has to be able to fail — a cookie naming an unknown codec, or
    bytes that contradict it — and latin-1 is the last resort because it can decode
    any byte string, so a mislabelled file is still indexed rather than dropped.
    """
    with open(path, 'rb') as handle:
        raw = handle.read()
    if raw.startswith(BOM):
        raw = raw[len(BOM):]
    try:
        encoding, _ = tokenize.detect_encoding(io.BytesIO(raw).readline)
    except SyntaxError:
        encoding = 'utf-8'
    try:
        return raw.decode(encoding)
    except (UnicodeDecodeError, LookupError):
        return raw.decode('latin-1')


# --- symbols --------------------------------------------------------------


def assignment_names(target, out):
    """Every simple name one assignment target binds."""
    if isinstance(target, ast.Name):
        out.append(target.id)
    elif isinstance(target, (ast.Tuple, ast.List)):
        for element in target.elts:
            assignment_names(element, out)
    elif isinstance(target, ast.Starred):
        assignment_names(target.value, out)


def is_type_checking(test):
    """`if TYPE_CHECKING:` and `if typing.TYPE_CHECKING:`."""
    if isinstance(test, ast.Name):
        return test.id == 'TYPE_CHECKING'
    if isinstance(test, ast.Attribute):
        return test.attr == 'TYPE_CHECKING'
    return False


def catches_import_error(handler):
    """Whether one `except` clause is about a missing dependency."""
    kind = handler.type
    if kind is None:
        # A bare `except:` catches ImportError too.
        return True
    kinds = kind.elts if isinstance(kind, ast.Tuple) else [kind]
    for name in kinds:
        if isinstance(name, ast.Name) and name.id in ('ImportError', 'ModuleNotFoundError'):
            return True
    return False


def is_import_guard(node):
    if not isinstance(node, TRY_TYPES):
        return False
    return any(catches_import_error(handler) for handler in node.handlers)


def add_import(imports, seen, specifier, level):
    """One edge per specifier: `import os` twice is one dependency."""
    if specifier in seen:
        return
    seen.add(specifier)
    imports.append({'specifier': specifier, 'level': level})


def collect(body, symbols, imports, seen, guarded=False):
    """Walk one statement list.

    `guarded` is set inside an `if TYPE_CHECKING:` or `try/except ImportError`
    block. Those are where real dependency edges hide, so imports are collected
    there; declarations are not, because a name that only exists on one branch is
    a runtime fact about one environment, not a stable top-level declaration.
    Function and class bodies are never entered: the unit of design is the
    declaration, and a local variable is not something a reader can be shown.
    """
    for node in body:
        if isinstance(node, ast.Import):
            for alias in node.names:
                add_import(imports, seen, alias.name, 0)
            continue
        if isinstance(node, ast.ImportFrom):
            module = node.module or ''
            level = node.level or 0
            add_import(imports, seen, '.' * level + module, level)
            continue
        if guarded:
            continue
        if isinstance(node, ast.If) and is_type_checking(node.test):
            collect(node.body, symbols, imports, seen, True)
            collect(node.orelse, symbols, imports, seen, True)
        elif is_import_guard(node):
            collect(node.body, symbols, imports, seen, True)
            for handler in node.handlers:
                collect(handler.body, symbols, imports, seen, True)
            collect(node.orelse, symbols, imports, seen, True)
            collect(node.finalbody, symbols, imports, seen, True)
        elif isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
            symbols.append({'name': node.name, 'kind': 'function', 'line': node.lineno})
        elif isinstance(node, ast.ClassDef):
            symbols.append({'name': node.name, 'kind': 'class', 'line': node.lineno})
        elif isinstance(node, ast.Assign):
            names = []
            for target in node.targets:
                assignment_names(target, names)
            for name in names:
                symbols.append({'name': name, 'kind': 'const', 'line': node.lineno})
        elif isinstance(node, ast.AnnAssign):
            # `x: int` declares a type and binds nothing; only `x: int = 1` is a value.
            if node.value is None:
                continue
            names = []
            assignment_names(node.target, names)
            for name in names:
                symbols.append({'name': name, 'kind': 'const', 'line': node.lineno})


# --- one file -------------------------------------------------------------


def describe(error):
    """One line, short enough to be a diagnostic rather than a traceback."""
    message = ' '.join(str(error).split())
    return ('%s: %s' % (type(error).__name__, message)).strip()[:200]


def index_file(path):
    reply = {'path': path, 'imports': [], 'symbols': [], 'error': None}
    try:
        source = decode(path)
        # The only thing this process does to the analysed repository: parse it.
        tree = ast.parse(source, filename=path)
    except Exception as error:  # noqa: BLE001 - one bad file must not kill the sidecar
        reply['error'] = describe(error)
        return reply
    collect(tree.body, reply['symbols'], reply['imports'], set())
    return reply


# --- protocol -------------------------------------------------------------


def main():
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            message = json.loads(line)
        except ValueError:
            continue
        if not isinstance(message, dict):
            continue
        if message.get('type') == 'exit':
            return 0
        if message.get('type') != 'index':
            continue
        files = message.get('files')
        if not isinstance(files, list):
            continue
        for path in files:
            if not isinstance(path, str):
                continue
            # Flushed per file: the parent streams replies and a batch that stalls
            # would otherwise look like a hang it has to time out.
            sys.stdout.write(json.dumps(index_file(path)) + '\n')
            sys.stdout.flush()
    return 0


if __name__ == '__main__':
    sys.exit(main())
