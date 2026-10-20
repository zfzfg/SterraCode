"""Parse supplied source strings only. Never import or execute audited code."""
import ast
import json
import sys

sys.stdin.reconfigure(encoding="utf-8")
sys.stdout.reconfigure(encoding="utf-8")


def extract(item):
    source = item["source"]
    tree = ast.parse(source, filename=item["file"])
    parents = {child: parent for parent in ast.walk(tree) for child in ast.iter_child_nodes(parent)}
    records = []
    for node in ast.walk(tree):
        if not (isinstance(node, ast.JoinedStr) or isinstance(node, ast.Constant) and isinstance(node.value, str)):
            continue
        if isinstance(node, ast.Constant) and isinstance(parents.get(node), ast.JoinedStr):
            continue
        text = node.value if isinstance(node, ast.Constant) else "".join(
            part.value if isinstance(part, ast.Constant) else "${" + ast.unparse(part.value) + "}"
            for part in node.values
        )
        role = "value"
        context = ""
        field = ""
        owner = ""
        current = node
        while current in parents:
            parent = parents[current]
            if isinstance(parent, ast.Dict):
                for key, value in zip(parent.keys, parent.values):
                    if current is key:
                        role = "syntax-key"
                    if current is value and isinstance(key, ast.Constant) and isinstance(key.value, str):
                        field = field or key.value
            if isinstance(parent, ast.Call) and not context:
                context = ast.unparse(parent.func)
            if isinstance(parent, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
                owner = owner or parent.name
            current = parent
        if isinstance(parents.get(node), ast.Expr):
            expression = parents[node]
            container = parents.get(expression)
            if container and getattr(container, "body", [None])[0] is expression:
                role = "comment"
        records.append({
            "line": node.lineno, "endLine": node.end_lineno,
            "column": node.col_offset + 1, "text": text,
            "kind": "python-fstring" if isinstance(node, ast.JoinedStr) else "python-string",
            "role": role, "context": context, "field": field, "owner": owner,
            "source": ast.get_source_segment(source, node),
        })
    return {"file": item["file"], "records": records}


results = []
for item in json.load(sys.stdin):
    try:
        results.append(extract(item))
    except (SyntaxError, ValueError) as error:
        results.append({"file": item["file"], "error": str(error), "records": []})
json.dump(results, sys.stdout, ensure_ascii=False)
