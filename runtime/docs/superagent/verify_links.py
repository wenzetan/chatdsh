from pathlib import Path
from urllib.parse import unquote, urlsplit
import json
from markdown_it import MarkdownIt

root = Path(__file__).resolve().parents[2]
docs = root / 'docs'
sources = list((docs / 'superagent').glob('*.md')) + [
    docs / name for name in ['README.md', 'architecture.md', 'target-shape.md',
                            'design-delivery.md', 'system-completion-design.md',
                            'client-complete-spec.md', 'implementation-work-packages.md',
                            'deployment.md', 'telemetry.md', 'ui-feature-inventory.md',
                            'compatibility.md', 'next-steps.md']
] + [root.parent / 'README.md']
parser = MarkdownIt()
failures = []
count = 0
for source in sources:
    for token in parser.parse(source.read_text()):
        for child in token.children or []:
            if child.type != 'link_open':
                continue
            target = child.attrGet('href')
            parsed = urlsplit(target)
            if parsed.scheme or not parsed.path:
                continue
            count += 1
            path = (source.parent / unquote(parsed.path)).resolve()
            if not path.exists():
                failures.append({'source': str(source.relative_to(root.parent)), 'target': target})
print(json.dumps({'documents': len(sources), 'localLinks': count, 'failures': failures}, ensure_ascii=False, indent=2))
if failures:
    raise SystemExit(1)
