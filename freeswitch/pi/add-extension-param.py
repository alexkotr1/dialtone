"""Add the `extension` param to the landline gateway.

Modulus does not put the dialled number anywhere in the INVITE — not in the
Request-URI, not in a diversion header. The gateway's `extension` param is the
only thing that tells the dialplan which line was called, which is why the
Chronodesk gateway sets it and why a copy of those credentials needs it too.

Run on the Pi, as root:
    sudo python3 add-extension-param.py
"""

import pathlib
import sys

GATEWAY = pathlib.Path("/home/alex/dialtone-fs/conf/sip_profiles/external/landline.xml")

ANCHOR = '    <param name="from-domain" value="$${landline_realm}"/>'

ADDITION = """
    <!-- Modulus does not put the dialled number anywhere in the INVITE, so
         this param is the only thing that tells the dialplan which line was
         called. Without it the gateway reports the SIP username instead. -->
    <param name="extension" value="$${landline_did}"/>"""


def main() -> int:
    src = GATEWAY.read_text(encoding="utf-8")

    if 'name="extension"' in src:
        print("already present")
        return 0

    if src.count(ANCHOR) != 1:
        print(f"anchor matched {src.count(ANCHOR)} times; refusing to guess", file=sys.stderr)
        return 1

    GATEWAY.write_text(src.replace(ANCHOR, ANCHOR + ADDITION), encoding="utf-8")
    print("extension param added")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
