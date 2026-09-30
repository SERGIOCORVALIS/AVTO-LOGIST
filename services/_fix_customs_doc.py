from pathlib import Path
import re

p = Path("agents/intake.py")
text = p.read_text(encoding="utf-8")
new = '''def has_customs_doc(cargo: dict[str, Any] | None) -> bool:
    cargo = cargo or {}
    if cargo.get("invoice_value") not in (None, "", 0, 0.0):
        return True
    if cargo.get("invoice_doc") or cargo.get("packing_list"):
        return True
    # Spec/description from an uploaded file counts; a product URL alone does not
    if cargo.get("from_document") and (
        cargo.get("has_spec")
        or cargo.get("spec_description")
        or cargo.get("description")
        or cargo.get("name")
    ):
        return True
    return False
'''
m = re.search(r"def has_customs_doc\(.*?\n(?:    .*\n)*?    return False\n", text)
if not m:
    raise SystemExit("has_customs_doc not found")
p.write_text(text[: m.start()] + new + text[m.end() :], encoding="utf-8")
print("ok")
