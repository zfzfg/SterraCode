"""Bounded, recorded main-thread execution. This is not a sandbox."""
import sys
import os
import json
import math
import io

root, entry, output, stdin_file = sys.argv[1:5]
root = os.path.realpath(root)
sources = {}
for directory, _, files in os.walk(root):
    for name in files:
        if name.endswith('.py'):
            full = os.path.realpath(os.path.join(directory, name))
            sources[full] = os.path.relpath(full, root).replace(os.sep, '/')
stream = open(output, 'w', encoding='utf-8', buffering=1)
step = 0
size = 0
frames = {}
next_frame = 0
objects_seen = {}
keepalive = []
budget = 0

def send(record):
    global size
    text = json.dumps(record, ensure_ascii=True, allow_nan=False) + '\n'
    if size + len(text.encode('utf-8')) > 2 * 1024 * 1024 - 512:
        finish('trace_size_limit', False)
        os._exit(2)
    stream.write(text)
    stream.flush()
    size += len(text.encode('utf-8'))

def finish(reason, complete, error=None):
    record = {'kind': 'end', 'reason': reason, 'complete': complete}
    if error is not None:
        args = BaseException.args.__get__(error)
        record['error'] = {'type': type(error).__name__[:250], 'message': args[0][:250] if len(args) and type(args[0]) is str else '<Fehlerdetails nicht ausgewertet>'}
        if not (len(args) and type(args[0]) is str):
            record['error'].update({'messageKey': 'runner:trace.errorDetails', 'params': {}})
    stream.write(json.dumps(record) + '\n')
    stream.flush()

def value(v, objects, depth=0):
    global budget
    budget += 1
    if budget > 200:
        return {'type': 'truncated', 'value': '<Wertebudget erreicht>', 'truncated': True, 'valueMessage': {'key': 'runner:trace.valueBudget', 'params': {}}}
    t = type(v)
    if t is type(None) or t is bool:
        return {'type': t.__name__, 'value': v}
    if t is int:
        result = {'type': 'int', 'value': v if v.bit_length() < 53 else '<große Ganzzahl>', 'truncated': v.bit_length() >= 53}
        if v.bit_length() >= 53:
            result['valueMessage'] = {'key': 'runner:trace.bigInteger', 'params': {}}
        return result
    if t is float:
        result = {'type': 'float', 'value': v if math.isfinite(v) else '<nicht endlich>'}
        if not math.isfinite(v):
            result['valueMessage'] = {'key': 'runner:trace.nonFinite', 'params': {}}
        return result
    if t is str:
        return {'type': 'str', 'value': v[:250], 'length': len(v), 'truncated': len(v) > 250}
    if t not in (list, tuple, dict, set, frozenset):
        return {'type': 'unsupported', 'value': '<Objekt nicht ausgewertet>', 'valueMessage': {'key': 'runner:trace.unsupported', 'params': {}}}
    identity = id(v)
    if identity not in objects_seen:
        objects_seen[identity] = 'object-' + str(len(objects_seen) + 1)
        keepalive.append(v)
    ref = objects_seen[identity]
    result = {'type': t.__name__, 'length': len(v), 'ref': ref}
    if ref in objects:
        return result
    if depth >= 4:
        result['truncated'] = True
        return result
    obj = {'type': t.__name__, 'length': len(v), 'items': [], 'truncated': len(v) > 20}
    objects[ref] = obj
    iterator = iter(v.items()) if t is dict else iter(v)
    for i, item in enumerate(iterator):
        if i >= 20:
            break
        obj['items'].append([value(item[0], objects, depth+1), value(item[1], objects, depth+1)] if t is dict else value(item, objects, depth+1))
    return result

def trace(frame, event, arg):
    global step, next_frame, budget
    filename = os.path.realpath(frame.f_code.co_filename)
    if filename not in sources or event not in ('call', 'line', 'return', 'exception'):
        return trace
    if step >= 1000:
        finish('event_limit', False)
        os._exit(2)
    if frame not in frames:
        next_frame += 1
        frames[frame] = 'frame-' + str(next_frame)
    objects = {}
    budget = 0
    stack = []
    current = frame
    while current is not None and len(stack) < 30:
        if current in frames:
            local = {}
            for i, (name, v) in enumerate((item for item in current.f_locals.items() if not item[0].startswith('__'))):
                if i >= 20:
                    break
                local[name[:250]] = value(v, objects)
            stack.append({'frameId': frames[current], 'function': current.f_code.co_name[:250], 'file': sources.get(os.path.realpath(current.f_code.co_filename)), 'line': current.f_lineno, 'locals': local, 'truncated': len(current.f_locals) > 20})
        current = current.f_back
    step += 1
    record = {'kind': 'event', 'schemaVersion': 1, 'step': step, 'event': event, 'phase': 'before' if event == 'line' else 'at', 'file': sources[filename], 'line': frame.f_lineno, 'frameId': frames[frame], 'parentFrameId': frames.get(frame.f_back), 'function': frame.f_code.co_name[:250], 'locals': stack[0]['locals'], 'stack': stack, 'stackTruncated': current is not None, 'objects': objects}
    if event == 'return':
        record['returnValue'] = value(arg, objects)
    if event == 'exception':
        record['exception'] = {'type': type(arg[1]).__name__[:250], 'message': '<Ausnahme aufgetreten; siehe Gesamtergebnis>', 'messageKey': 'runner:trace.exception', 'params': {}}
    send(record)
    if event == 'return':
        del frames[frame]
    return trace

sys.path.insert(0, root)
sys.path.insert(0, os.path.dirname(os.path.join(root, entry)))
sys.stdin = io.StringIO(open(stdin_file, encoding='utf-8').read())
sys.argv = [entry]
try:
    code = compile(open(os.path.join(root, entry), encoding='utf-8-sig').read(), os.path.join(root, entry), 'exec')
    sys.settrace(trace)
    exec(code, {'__name__': '__main__', '__file__': os.path.join(root, entry)})
    sys.settrace(None)
    finish('completed', True)
except BaseException as error:
    sys.settrace(None)
    if type(error) is SystemExit and (error.code is None or error.code == 0):
        finish('completed', True)
    else:
        finish('program_error', True, error)
        sys.exit(1)
