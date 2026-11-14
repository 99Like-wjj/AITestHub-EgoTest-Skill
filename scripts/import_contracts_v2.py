"""Import the explicitly selected deployed v2 structural snapshot, offline only."""
from pathlib import Path
import hashlib
import json
import sys
from contract_metadata import public_contract_manifest


def main():
    root = Path(__file__).resolve().parent.parent
    source = Path(sys.argv[1]).resolve(strict=True)
    manifest = json.loads((source / 'manifest.json').read_text(encoding='utf-8'))
    for name in ['catalog.json', 'components.json']:
        if hashlib.sha256((source / name).read_bytes()).hexdigest() != manifest['files'][name]:
            raise ValueError('Upstream snapshot digest mismatch')
    all_schemas = json.loads((source / 'components.json').read_text(encoding='utf-8'))['schemas']
    keep = {'domain.executionScopeSchema', 'domain.resultItemSchema',
            'domain.evidenceManifestItemSchema', 'domain.uiProgressInputSchema'}
    schemas = {k: v for k, v in all_schemas.items() if k.startswith('ui-delivery.') or k in keep}
    families = {'ath_ui_executions', 'ath_results', 'ath_file_transfers', 'ath_operation_status'}
    tools = {t['name']: t['inputSchema'] for t in json.loads((source / 'catalog.json').read_text(encoding='utf-8'))['tools'] if t['name'] in families}
    if len(tools) != 4 or 'ui-delivery.uiResultBatchSchema' not in schemas:
        raise ValueError('Required deployed capability is absent')
    value = {'artifactId': source.name, 'schemas': schemas, 'tools': tools}
    encoded = (json.dumps(value, ensure_ascii=False, indent=2) + '\n').encode('utf-8')
    name = source.name + '-v2.json'
    destination = root / 'contracts' / name
    if destination.exists() and destination.read_bytes() != encoded:
        raise ValueError('Immutable v2 snapshot differs')
    destination.write_bytes(encoded)
    provenance = {'artifactId': source.name, 'upstreamManifest': public_contract_manifest(manifest),
                  'derivative': {'path': name, 'sha256': hashlib.sha256(encoded).hexdigest()},
                  'structuralOnly': True, 'serverBusinessAuthority': True}
    (root / 'contracts' / 'v2-provenance.json').write_text(json.dumps(provenance, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    print(json.dumps({'artifactId': source.name, 'components': len(schemas), 'families': len(tools), 'sha256': provenance['derivative']['sha256']}))


if __name__ == "__main__":
    main()
