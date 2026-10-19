"""Fixed function harness. stdout is never an assessment protocol."""
import sys
import os
import json
import math
import traceback
import importlib.util

source, entry, function, args_path, result_path = sys.argv[1:]
# Keep the original descriptor and serializers before importing learner code.
out = open(result_path, "w", encoding="utf-8")
dumps = json.dumps
args = json.load(open(args_path, encoding="utf-8"))

def checked(value, seen=None, depth=0):
    if depth > 20:
        raise ValueError("Rückgabe zu tief verschachtelt (maximal 20).")
    t = type(value)
    if value is None or t in (str, bool):
        return value
    if t in (int, float):
        if abs(value) > 9007199254740991 or (t is float and not math.isfinite(value)):
            raise ValueError("Nicht endliche Zahl oder Zahl außerhalb des sicheren JSON-Bereichs.")
        return value
    if t not in (list, dict):
        raise ValueError("Nicht unterstützter Rückgabetyp: " + t.__name__)
    seen = set() if seen is None else seen
    if id(value) in seen:
        raise ValueError("Zyklische Rückgabe wird nicht unterstützt.")
    seen.add(id(value))
    try:
        if t is list:
            return [checked(v, seen, depth + 1) for v in value]
        if any(type(k) is not str for k in value):
            raise ValueError("Objektschlüssel müssen Strings sein.")
        return {k: checked(v, seen, depth + 1) for k, v in value.items()}
    finally:
        seen.remove(id(value))

try:
    sys.path.insert(0, source)
    sys.path.insert(0, os.path.dirname(os.path.join(source, entry)))
    spec = importlib.util.spec_from_file_location("learner_solution", os.path.join(source, entry))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    result = getattr(module, function)(*args)
    try:
        payload = {"kind": "return", "actual": checked(result), "runtime": sys.version.split()[0]}
    except ValueError as error:
        payload = {"kind": "serialization_error", "message": str(error)[:500]}
except BaseException as error:
    frames = traceback.extract_tb(error.__traceback__)
    location = next((f for f in reversed(frames) if os.path.abspath(f.filename).startswith(source + os.sep)), None)
    payload = {"kind": "program_error", "message": type(error).__name__ + ": " + str(error)[:500]}
    if isinstance(error, SyntaxError):
        payload.update({"file": entry, "line": error.lineno})
    elif location:
        payload.update({"file": os.path.relpath(location.filename, source).replace(os.sep, "/"), "line": location.lineno})
encoded = dumps(payload, ensure_ascii=True, allow_nan=False)
if len(encoded) > 65536:
    encoded = dumps({"kind": "serialization_error", "message": "Rückgabe überschreitet 64 KiB."})
out.write(encoded)
out.flush()
out.close()
