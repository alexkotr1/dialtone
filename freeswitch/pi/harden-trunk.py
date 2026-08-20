"""Stop SIP scanners from reaching the softphone.

The trunk port has to be reachable from the internet for inbound calls to
arrive, so it is reachable by everyone else too. Scanners find it in hours and
send a continuous stream of INVITEs to guessed extensions (101, 6801, 1000...).
Two things were letting those through to the phone:

1. No inbound ACL on the external profile, so FreeSWITCH accepted SIP from any
   source address.
2. A dialplan rule in the `public` context matching `^.*$`. The public context
   is where UNAUTHENTICATED internet SIP lands — not just the trunk — so a
   catch-all there routes the whole internet to extension 1005.

This applies both fixes. Run on the Pi as root:

    sudo python3 harden-trunk.py

Then:

    docker exec dialtone-freeswitch fs_cli -P 8022 -x reloadxml
    docker exec dialtone-freeswitch fs_cli -P 8022 -x "sofia profile external restart"
"""

import pathlib
import re
import sys

CONF = pathlib.Path("/home/alex/dialtone-fs/conf")

# Modulus's registrar/proxy, plus the private ranges their SBC and our own
# loopback tests come from. Private ranges are not routable from the internet,
# so allowing them does not open anything up.
ACL = """
    <!-- Who may send SIP to the trunk profile. Everything else is dropped
         before it reaches the dialplan. Without this, scanners on the public
         internet reach extension 1005 directly. -->
    <list name="dialtone_trunk" default="deny">
      <node type="allow" cidr="185.73.43.0/24"/>   <!-- voips.modulus.gr -->
      <node type="allow" cidr="10.0.0.0/8"/>       <!-- carrier SBC, private -->
      <node type="allow" cidr="172.16.0.0/12"/>
      <node type="allow" cidr="192.168.0.0/16"/>
      <node type="allow" cidr="127.0.0.0/8"/>
      <node type="allow" cidr="100.64.0.0/10"/>    <!-- mesh VPN -->
    </list>
"""


def patch_acl() -> None:
    path = CONF / "autoload_configs" / "acl.conf.xml"
    src = path.read_text(encoding="utf-8")
    if "dialtone_trunk" in src:
        print("acl: already present")
        return
    path.write_text(src.replace("<network-lists>", "<network-lists>" + ACL, 1), encoding="utf-8")
    print("acl: dialtone_trunk added")


def patch_profile() -> None:
    path = CONF / "sip_profiles" / "external.xml"
    src = path.read_text(encoding="utf-8")
    if "apply-inbound-acl" in src:
        print("external profile: apply-inbound-acl already present")
        return
    # Anchor on the profile's own settings block so this lands inside it.
    anchor = "<settings>"
    if src.count(anchor) != 1:
        print(f"external profile: {src.count(anchor)} <settings> blocks, refusing to guess", file=sys.stderr)
        sys.exit(1)
    src = src.replace(
        anchor,
        anchor + '\n    <param name="apply-inbound-acl" value="dialtone_trunk"/>',
        1,
    )
    path.write_text(src, encoding="utf-8")
    print("external profile: apply-inbound-acl=dialtone_trunk")


def patch_dialplan(did: str) -> None:
    """Route only our own number; let everything else fall through to a 404."""
    path = CONF / "dialplan" / "public" / "00_dialtone_inbound.xml"
    # Accept the DID in E.164, with or without +, and in national form.
    national = did.lstrip("+")
    if national.startswith("30"):
        national = national[2:]
    pattern = f"^(\\+?30)?{re.escape(national)}$"

    path.write_text(
        f"""<include>
  <!-- Only this line's own number is routed to the softphone.
       This used to match ^.*$ on the reasoning that the instance has one
       gateway and one user. That was wrong: the `public` context is where
       UNAUTHENTICATED internet SIP arrives, not just trunk calls, so the
       catch-all handed every scanner on the internet a direct line to
       extension 1005. Anything that is not our DID now falls through with no
       match, and FreeSWITCH answers 404 without ringing anything. -->
  <extension name="dialtone_inbound">
    <condition field="destination_number" expression="{pattern}">
      <action application="set" data="domain_name=$${{domain}}"/>

      <!-- Pin the codecs offered TO the softphone. Without this FreeSWITCH
           offers whatever the inbound leg used, which Chromium may not
           support, producing INCOMPATIBLE_DESTINATION. `nolocal:` keeps the
           trunk leg free to stay G.711. -->
      <action application="export" data="nolocal:absolute_codec_string=opus,PCMU,PCMA"/>

      <action application="transfer" data="1005 XML default"/>
    </condition>
  </extension>
</include>
""",
        encoding="utf-8",
    )
    print(f"dialplan: inbound restricted to {pattern}")


def main() -> int:
    vars_file = CONF / "vars" / "dialtone_vars.xml"
    m = re.search(r'data="landline_did=([^"]*)"', vars_file.read_text(encoding="utf-8"))
    did = (m.group(1) if m else "").strip()
    if not did or did == "CHANGEME":
        print("landline_did is not set; cannot restrict the dialplan", file=sys.stderr)
        return 1

    patch_acl()
    patch_profile()
    patch_dialplan(did)
    print("\nNow reload:")
    print('  docker exec dialtone-freeswitch fs_cli -P 8022 -x reloadacl')
    print('  docker exec dialtone-freeswitch fs_cli -P 8022 -x reloadxml')
    print('  docker exec dialtone-freeswitch fs_cli -P 8022 -x "sofia profile external restart"')
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
