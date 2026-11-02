from pathlib import Path
from urllib.parse import unquote, urlsplit
import json
from markdown_it import MarkdownIt

root = Path(__file__).resolve().parents[2]
docs = root / 'runtime' / 'docs'
names = ['design-delivery.md', 'client-complete-spec.md', 'system-completion-design.md', 'implementation-work-packages.md', 'design-verification.md']
parser = MarkdownIt()
links = []
failures = []
for name in names:
    source = docs / name
    if not source.is_file():
        failures.append(f'缺少文档：{name}')
        continue
    tokens = parser.parse(source.read_text())
    for token in tokens:
        for child in token.children or []:
            if child.type != 'link_open':
                continue
            target = child.attrGet('href')
            parsed = urlsplit(target)
            if parsed.scheme or not parsed.path:
                continue
            path = (source.parent / unquote(parsed.path)).resolve()
            links.append({'source': name, 'target': target})
            if not path.exists():
                failures.append(f'{name} 引用目标不存在：{target}')
report = {'documents': len(names), 'links': len(links), 'failures': failures}
print(json.dumps(report, ensure_ascii=False, indent=2))
if failures:
    raise SystemExit(1)
