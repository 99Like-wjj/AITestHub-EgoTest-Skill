"""Portable package validation; the Codex-specific validator is optional."""
import json
import os
import re
import subprocess
import sys
from pathlib import Path


def validate_skill(root):
    skill = root / "skills" / "ath-web-execute"
    content = (skill / "SKILL.md").read_text(encoding="utf-8")
    frontmatter = re.match(r"\A---\r?\n([\s\S]*?)\r?\n---", content)
    if not frontmatter:
        raise ValueError("Missing Skill frontmatter")
    header = frontmatter.group(1)
    if not re.search(r"^name:\s*ath-web-execute\s*$", header, re.MULTILINE):
        raise ValueError("Unexpected Skill name")
    if not re.search(r"^description:\s*\S", header, re.MULTILINE):
        raise ValueError("Missing Skill description")
    if re.search(r"\bTODO\b|\[placeholder\]", content, re.IGNORECASE):
        raise ValueError("Unfinished Skill entry")
    for reference in re.findall(r"\[[^\]]*\]\(([^)]+)\)", content):
        if reference.startswith(("https://", "http://", "#")):
            continue
        target = (skill / reference.split("#", 1)[0]).resolve()
        target.relative_to(skill.resolve())
        if not target.is_file() or target.is_symlink():
            raise ValueError("Missing or linked Skill reference")
    manifest = json.loads((skill / "manifest.json").read_text(encoding="utf-8"))
    package = json.loads((root / "package.json").read_text(encoding="utf-8"))
    if manifest["version"] != package["version"]:
        raise ValueError("Skill/package version mismatch")
    return skill


def main():
    root = Path(__file__).resolve().parent.parent
    skill = validate_skill(root)
    # Existing runtime diagnostics verify generated hashes without any network/host.
    result = subprocess.run(
        ["node", str(skill / "scripts" / "tool.mjs"), "tool-info"], check=False
    )
    if result.returncode:
        return result.returncode
    external = os.environ.get("SKILL_CREATOR_HOME")
    if external:
        validator = Path(external) / "scripts" / "quick_validate.py"
        if not validator.is_file():
            raise ValueError("Configured optional validator is missing")
        return subprocess.call(
            [sys.executable, "-X", "utf8", str(validator), str(skill)]
        )
    print(json.dumps({"basicStructure": True, "references": True, "externalValidatorRequired": False}))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
