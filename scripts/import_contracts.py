"""Explicit, offline vendor import; never reads keys or contacts the platform."""
import hashlib
import json
import sys
from contract_metadata import public_contract_manifest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
COMPONENTS = [
    'domain.executionScopeSchema', 'domain.resultItemSchema',
    'domain.evidenceManifestItemSchema', 'domain.resultSubmissionSchema',
    'domain.resultSubmissionReceiptSchema', 'domain.uiProgressInputSchema',
    'ui-results.claimLocalExecutionInputSchema',
]
TOOLS = ['ath_ui_executions', 'ath_results', 'ath_file_transfers', 'ath_operation_status']

def sha(data):
    return hashlib.sha256(data).hexdigest()

def main():
    source = Path(sys.argv[1]).resolve(strict=True)
    manifest = json.loads((source / 'manifest.json').read_text(encoding='utf-8'))
    for name in ['catalog.json', 'components.json']:
        if sha((source / name).read_bytes()) != manifest['files'][name]:
            raise ValueError('Upstream snapshot hash mismatch: ' + name)
    schemas = json.loads((source / 'components.json').read_text(encoding='utf-8'))['schemas']
    catalog = json.loads((source / 'catalog.json').read_text(encoding='utf-8'))['tools']
    subset = {'artifactId': source.name, 'schemas': {k: schemas[k] for k in COMPONENTS},
              'tools': {t['name']: t['inputSchema'] for t in catalog if t['name'] in TOOLS}}
    encoded = (json.dumps(subset, ensure_ascii=False, indent=2) + '\n').encode('utf-8')
    destination = ROOT / 'contracts' / (source.name + '.json')
    destination.parent.mkdir(exist_ok=True)
    if destination.exists() and destination.read_bytes() != encoded:
        raise ValueError('Immutable derivative already exists with different bytes')
    destination.write_bytes(encoded)
    provenance = {'artifactId': source.name, 'upstreamManifest': public_contract_manifest(manifest),
                  'derivative': {'path': destination.name, 'sha256': sha(encoded)},
                  'structuralOnly': True, 'serverBusinessAuthority': True}
    (ROOT / 'contracts' / 'manifest.json').write_text(json.dumps(provenance, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    print(json.dumps({'artifactId': source.name, 'components': len(COMPONENTS), 'tools': len(subset['tools']), 'sha256': sha(encoded)}))

if __name__ == '__main__':
    main()
