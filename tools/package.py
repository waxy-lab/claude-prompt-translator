"""Allowlisted packaging: excludes tests, profiles, and other workspace files."""
from pathlib import Path
from zipfile import ZipFile, ZIP_DEFLATED
import hashlib
import json
import shutil
import subprocess

ROOT = Path(__file__).resolve().parents[1]
FILES = [
    'manifest.json', 'background.js', 'sidepanel.html', 'sidepanel.css', 'sidepanel.js',
    'lib/target.js', 'lib/protected-text.js', 'lib/task-gate.js', 'lib/translator.js',
    'lib/draft-store.js', 'content/claude-adapter.js', 'README.md', 'TEST_REPORT.md', 'DESIGN.md',
    'lib/auto-reader.js', 'lib/reply-translator.js', 'lib/text-boundary.js', 'content/reply-reader.js', 'NEXT_TASK.md',
    'lib/reply-format.js', 'lib/reply-text.js',
    'evidence/chrome-probe-2026-10-27.json', 'evidence/unit-tests.txt',
    'evidence/browser-fixtures.json',
    'evidence/reading-browser-fixtures.json', 'evidence/local-model-0.2.0.json', 'evidence/unit-tests-0.1.1.txt',
    'evidence/unit-tests-0.2.0.txt', 'evidence/quality-model-0.2.1.json',
    'evidence/quality-model-0.2.1-attempt1.json', 'evidence/quality-model-0.2.1-attempt2.json',
    'evidence/quality-model-0.2.1-initial-protocol.json', 'evidence/quality-model-0.2.1-marker-diagnostics.json',
    'UI_TASK.md', 'evidence/ui-0.2.3.json',
    'LANGUAGE_LABEL_TASK.md', 'evidence/language-label-0.2.4.json', 'evidence/language-model-0.2.4.json',
]
FILES += [f'evidence/ui-0.2.3/{name}.png' for name in [
    'empty-light-400', 'preparing-light-400',
    'original-light-320', 'original-light-400', 'original-light-600',
    'original-dark-320', 'original-dark-400', 'original-dark-600',
    'translated-light-400', 'translated-dark-400', 'ask-light-320', 'ask-dark-600',
    'confirm-light-400', 'boundary-light-400', 'question-loading-light-400',
    'question-error-light-400', 'reader-error-light-400',
]]

def main():
    manifest = json.loads((ROOT / 'manifest.json').read_text(encoding='utf-8'))
    assert manifest['manifest_version'] == 3
    assert sorted(manifest['permissions']) == sorted(['sidePanel', 'activeTab', 'scripting', 'storage'])
    assert not manifest.get('host_permissions')
    for name in FILES:
        assert (ROOT / name).is_file(), name
        if name.endswith('.js'):
            subprocess.run(['node', '--check', str(ROOT / name)], check=True, capture_output=True)
    destination = ROOT / 'dist' / 'claude-english-assistant'
    destination.mkdir(parents=True, exist_ok=True)
    existing = {p.relative_to(destination).as_posix() for p in destination.rglob('*') if p.is_file()}
    assert not (existing - set(FILES)), f'Unexpected delivery files: {existing - set(FILES)}'
    hashes = {}
    for name in FILES:
        target = destination / name
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(ROOT / name, target)
        hashes[name] = hashlib.sha256(target.read_bytes()).hexdigest()
    archive = ROOT / 'dist' / f'claude-english-assistant-{manifest["version"]}.zip'
    with ZipFile(archive, 'w', ZIP_DEFLATED) as bundle:
        for name in FILES:
            bundle.write(destination / name, f'claude-english-assistant/{name}')
    with ZipFile(archive) as bundle:
        assert bundle.testzip() is None
        assert set(bundle.namelist()) == {f'claude-english-assistant/{name}' for name in FILES}
        for name, expected in hashes.items():
            assert hashlib.sha256(bundle.read(f'claude-english-assistant/{name}')).hexdigest() == expected
    (ROOT / 'dist' / 'BUILD_INFO.json').write_text(json.dumps({
        'version': manifest['version'], 'files': hashes, 'zip': archive.name,
        'zip_sha256': hashlib.sha256(archive.read_bytes()).hexdigest(),
        'checks': ['JS syntax: pass', 'manifest permissions: pass', 'ZIP integrity: pass', 'directory/ZIP hashes: match'],
        'scope': 'Packaging checks only. No native sidepanel/Claude compatibility claim.'
    }, indent=2, ensure_ascii=False) + '\n', encoding='utf-8')
    print(f'Loadable directory: {destination}')
    print(f'ZIP: {archive} ({archive.stat().st_size} bytes)')
    print(f'Validated {len(FILES)} allowlisted files; syntax and ZIP integrity passed.')

if __name__ == '__main__':
    main()
