"""Schema provenance for code packages; deployment records stay outside them."""
import re


def public_contract_manifest(manifest):
    """Copy structural metadata only, never arbitrary upstream provenance."""
    result = {
        key: manifest[key]
        for key in (
            "artifactVersion",
            "protocolVersion",
            "publicationState",
            "mainPublished",
            "structuralValidationOnly",
            "serverRemainsBusinessAuthority",
            "toolCount",
            "componentCount",
            "omittedComponents",
        )
        if key in manifest
    }
    files = manifest.get("files", {})
    result["files"] = {}
    for name in ("catalog.json", "components.json"):
        digest = files.get(name)
        if not isinstance(digest, str) or not re.fullmatch(r"[a-f0-9]{64}", digest):
            raise ValueError("Invalid contract file digest")
        result["files"][name] = digest
    result["privacyFiltered"] = True
    return result
