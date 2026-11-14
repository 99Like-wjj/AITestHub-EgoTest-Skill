"""Deterministic complete-folder ZIP; does not install the Skill."""
import hashlib
import io
import json
import zipfile
from pathlib import Path

root = Path(__file__).resolve().parent.parent
skill = root / 'skills' / 'ath-web-execute'
manifest = json.loads((skill / 'manifest.json').read_text(encoding='utf-8'))
inventory = json.loads((skill / 'integrity.json').read_text(encoding='utf-8'))['files']
actual = sorted(p.relative_to(skill).as_posix() for p in skill.rglob('*') if p.is_file() and p.name != 'integrity.json')
if actual != sorted(inventory):
    raise ValueError('Package entries differ from verified build inventory')
for name, expected in inventory.items():
    if hashlib.sha256((skill / name).read_bytes()).hexdigest() != expected:
        raise ValueError('Package bytes changed after build: ' + name)
output = root / 'dist' / ('ath-web-execute-' + manifest['version'] + '.zip')
buffer = io.BytesIO()
with zipfile.ZipFile(buffer, 'w', compression=zipfile.ZIP_DEFLATED, compresslevel=9) as archive:
    for path in sorted(skill.rglob('*')):
        if path.is_symlink():
            raise ValueError('No package symlinks')
        if path.is_file():
            info = zipfile.ZipInfo('ath-web-execute/' + path.relative_to(skill).as_posix(), date_time=(1980, 1, 1, 0, 0, 0))
            info.compress_type = zipfile.ZIP_DEFLATED
            info.external_attr = 0o100644 << 16
            archive.writestr(info, path.read_bytes(), compress_type=zipfile.ZIP_DEFLATED, compresslevel=9)
package_bytes = buffer.getvalue()
if output.exists() and output.read_bytes() != package_bytes:
    raise ValueError('Existing frozen version has different bytes; use a new candidate version, never overwrite it')
if not output.exists():
    output.write_bytes(package_bytes)
digest = hashlib.sha256(package_bytes).hexdigest()
receipt = {'path': str(output), 'sha256': digest, 'bytes': output.stat().st_size, 'entryCount': len(actual) + 1,
           'installed': False, 'liveVerified': False}
output.with_suffix('.inventory.json').write_text(json.dumps(receipt, indent=2) + '\n', encoding='utf-8')
print(json.dumps(receipt))
