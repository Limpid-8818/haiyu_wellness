#!/usr/bin/env python3
"""Literal production dependencies, including re-exports and dynamic imports; Tarjan SCC."""
import json, re, posixpath
from pathlib import Path

PATTERN = r"(?:\bfrom\s*|\bimport\s*(?:\(\s*)?)[\"'](\.[^\"']+)[\"']"

def dependency_graph(src):
    files = {str(p.relative_to(src)): p.read_text() for p in src.rglob('*.js')}
    graph = {}
    for file, body in files.items():
        graph[file] = sorted(set(posixpath.normpath(posixpath.join(posixpath.dirname(file), spec))
            for spec in re.findall(PATTERN, body)))
        for target in graph[file]:
            assert target in files, (file, target)
    return graph

def reachable(graph, roots):
    seen = set()
    def visit(node):
        if node in seen: return
        seen.add(node)
        for target in graph[node]: visit(target)
    for root in roots: visit(root)
    return seen

def scc(graph):
    indices, low, stack, active, result = {}, {}, [], set(), []
    def visit(node):
        indices[node] = low[node] = len(indices)
        stack.append(node); active.add(node)
        for target in graph[node]:
            if target not in indices:
                visit(target); low[node] = min(low[node], low[target])
            elif target in active: low[node] = min(low[node], indices[target])
        if low[node] == indices[node]:
            group = []
            while True:
                target = stack.pop(); active.remove(target); group.append(target)
                if target == node: break
            if len(group) > 1 or node in graph[node]: result.append(sorted(group))
    for node in graph:
        if node not in indices: visit(node)
    return sorted(result)

if __name__ == '__main__':
    import argparse
    p = argparse.ArgumentParser(); p.add_argument('--output', required=True)
    a = p.parse_args()
    graph = dependency_graph(Path(__file__).resolve().parents[2]/'server/src')
    result = dict(graph=graph, modules=len(graph), edges=sum(map(len, graph.values())), scc=scc(graph))
    with Path(a.output).open('x') as f: json.dump(result, f, indent=2); f.write('\n')
    print(json.dumps({k:v for k,v in result.items() if k != 'graph'}))
