"""lens_hash.py — one SHA-256 over the text a review follows.

lens_hash(skill_dir) hashes lenses/*.md and references/*.md under the tu-code-review folder, in
sorted relative-path order, so two copies with the same text give the same hash.
"""
import hashlib
from pathlib import Path


def lens_hash(skill_dir):
    """skill_dir: the tu-code-review folder. Returns 64 hex characters."""
    root = Path(skill_dir).resolve()
    files = list((root / "lenses").glob("*.md")) + list((root / "references").glob("*.md"))
    digest = hashlib.sha256()
    for path in sorted(files, key=lambda p: p.relative_to(root).as_posix()):
        digest.update(path.relative_to(root).as_posix().encode("utf-8") + b"\0")
        digest.update(path.read_bytes() + b"\0")
    return digest.hexdigest()


if __name__ == "__main__":
    import sys
    print(lens_hash(sys.argv[1] if len(sys.argv) > 1 else Path(__file__).resolve().parent.parent))
