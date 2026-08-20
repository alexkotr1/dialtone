#!/usr/bin/env bash
#
# Stand up a SECOND FreeSWITCH on the Pi, for Dialtone, without touching the
# one Chronodesk is using.
#
# The existing instance carries a live Modulus trunk and the AI phone agent.
# Nothing here writes to its config, its container, or its ports — the only
# thing the two share is the host network stack, and every port below is
# chosen to avoid the ones it already holds:
#
#     Chronodesk        Dialtone
#     5060  internal    5062  internal (softphone registers here)
#     5080  external    5082  external (landline gateway registers outward)
#     5066  ws          5068  ws
#     7443  wss         7445  wss
#     8021  ESL         8022  ESL
#     16384-32768 RTP   32769-40000 RTP
#
# Reuses the chronodesk-freeswitch image rather than building a second one:
# it already has mod_sofia, mod_opus and DTLS-SRTP, which is everything
# WebRTC needs, and a rebuild on a Pi 5 is the better part of an hour.
#
# Idempotent. Re-running replaces the container and reapplies the config.
#
#   ./setup.sh

set -euo pipefail

IMAGE="chronodesk-freeswitch:v1.10.12"
NAME="dialtone-freeswitch"
ROOT="/home/alex/dialtone-fs"
CONF="$ROOT/conf"

# The address Dialtone reaches the Pi on. This is the NordVPN Meshnet
# interface: the app runs on another machine, and this is the only address
# that reaches the Pi from there. Media binds here too, so RTP follows the
# same encrypted path as the signalling.
BIND_IP="$(ip -4 -o addr show nordlynx 2>/dev/null | awk '{print $4}' | cut -d/ -f1)"
if [ -z "$BIND_IP" ]; then
  echo "!! No nordlynx address. Is the mesh VPN up? (ip -4 -o addr show)" >&2
  exit 1
fi

# The LAN address, used by the external profile so the landline gateway can
# reach the internet — the mesh interface cannot.
LAN_IP="$(ip -4 -o addr show eth0 | awk '{print $4}' | cut -d/ -f1)"

echo "bind (softphone side): $BIND_IP"
echo "lan  (landline side):  $LAN_IP"

# --- 1. a config tree of our own -------------------------------------------
#
# Copied out of the image rather than written from scratch: FreeSWITCH's
# default config is several hundred files and most of them are load-bearing.
# We take a full copy and patch the handful that matter, so anything not
# mentioned below keeps the stock behaviour.

if [ ! -d "$CONF" ]; then
  echo "== extracting stock config from the image"
  mkdir -p "$ROOT"
  TMP="$(sudo docker create "$IMAGE")"
  sudo docker cp "$TMP:/usr/local/freeswitch/etc/freeswitch" "$CONF"
  sudo docker rm "$TMP" >/dev/null
else
  echo "== reusing existing config at $CONF"
fi

# Take ownership for the duration of the edits, and hand it back to the
# container's uid at the end. A bind-mounted directory keeps its HOST
# ownership inside the container, and FreeSWITCH must be able to write here:
# certs_dir is etc/freeswitch/tls, inside this very tree, and FreeSWITCH
# generates its own WebSocket and DTLS certificates into it on first start.
# Leaving the tree owned by a human account is what makes that fail, and it
# fails as "Bad WSS.PEM certificate" — which takes the whole internal profile
# down with it, not just the TLS listener.
sudo chown -R "$(id -u):$(id -g)" "$CONF"

# --- 2. ports and addresses ------------------------------------------------

echo "== patching ports"
V="$CONF/vars.xml"
sed -i \
  -e 's|internal_sip_port=5060|internal_sip_port=5062|' \
  -e 's|external_sip_port=5080|external_sip_port=5082|' \
  -e 's|internal_tls_port=5061|internal_tls_port=5063|' \
  -e 's|external_tls_port=5081|external_tls_port=5083|' \
  "$V"

# One variable for the softphone-facing address, so the profile does not
# hardcode an IP that changes when the mesh does.
if ! grep -q 'dialtone_bind_ip' "$V"; then
  sed -i "s|<X-PRE-PROCESS cmd=\"set\" data=\"internal_sip_port=5062\"/>|<X-PRE-PROCESS cmd=\"set\" data=\"internal_sip_port=5062\"/>\n  <X-PRE-PROCESS cmd=\"set\" data=\"dialtone_bind_ip=$BIND_IP\"/>|" "$V"
else
  sed -i "s|data=\"dialtone_bind_ip=.*\"|data=\"dialtone_bind_ip=$BIND_IP\"|" "$V"
fi

# RTP away from Chronodesk's range, or the two instances hand out the same
# ports and calls fail intermittently in a way that looks like a network fault.
sed -i \
  -e 's|name="rtp-start-port" value="[0-9]*"|name="rtp-start-port" value="32769"|' \
  -e 's|name="rtp-end-port" value="[0-9]*"|name="rtp-end-port" value="40000"|' \
  "$CONF/autoload_configs/switch.conf.xml"

sed -i 's|name="listen-port" value="8021"|name="listen-port" value="8022"|' \
  "$CONF/autoload_configs/event_socket.conf.xml"

# The stock dialplan ships a nag extension that matches EVERY destination
# while default_password is still "1234", logs four CRIT lines and then does
# sleep(10000). It runs before any real rule, so inbound calls appear to
# connect to silence for ten seconds and then fail. Changing the password is
# what disarms it.
if grep -q 'default_password=1234' "$V"; then
  sed -i "s|data=\"default_password=1234\"|data=\"default_password=$(tr -dc 'A-Za-z0-9' </dev/urandom | head -c 20)\"|" "$V"
  echo "   default_password changed (this is the stock nag guard, not the softphone password)"
fi

# --- 3. the softphone-facing profile ---------------------------------------

echo "== patching the internal profile for WebRTC"
I="$CONF/sip_profiles/internal.xml"
sed -i \
  -e 's|name="sip-ip" value="\$\${local_ip_v4}"|name="sip-ip" value="$${dialtone_bind_ip}"|' \
  -e 's|name="rtp-ip" value="\$\${local_ip_v4}"|name="rtp-ip" value="$${dialtone_bind_ip}"|' \
  -e 's|name="ws-binding"  value=":5066"|name="ws-binding"  value=":5068"|' \
  -e 's|name="wss-binding" value=":7443"|name="wss-binding" value=":7445"|' \
  "$I"

# Both ends are already inside the mesh VPN's tunnel, so there is no NAT
# between them and no third party to hide the media from. Pointing these at
# the mesh address stops FreeSWITCH advertising the Pi's public IP in SDP,
# which is an address the app cannot route to.
sed -i \
  -e 's|name="ext-rtp-ip" value="\$\${external_rtp_ip}"|name="ext-rtp-ip" value="$${dialtone_bind_ip}"|' \
  -e 's|name="ext-sip-ip" value="\$\${external_sip_ip}"|name="ext-sip-ip" value="$${dialtone_bind_ip}"|' \
  "$I"

# --- 3b. which ICE candidates are allowed ----------------------------------
#
# The one that is genuinely hard to find.
#
# With no candidate-acl set, FreeSWITCH defaults to `wan.auto`, which denies
# RFC1918 *and* 100.64.0.0/10 — carrier-grade NAT space. Mesh VPNs hand out
# addresses from exactly that range, so every candidate the app offers gets
# discarded: FreeSWITCH logs "Save audio Candidate ... 100.x.x.x", then has
# nothing left to try, waits out the ICE timer, and answers 488. JsSIP
# reports that as "No common audio codec", which is the opposite of true —
# the debug log shows opus negotiated successfully first.
#
# So: allow the mesh and the LAN explicitly, then fall back to wan.auto for
# anything genuinely public.

echo "== allowing mesh + LAN ICE candidates"
A="$CONF/autoload_configs/acl.conf.xml"
if ! grep -q 'dialtone_trunk' "$A"; then
  python3 - "$A" <<'PY'
import sys, re
path = sys.argv[1]
src = open(path, encoding="utf-8").read()
acl = '''
    <!-- Who may send SIP to the trunk profile at all. The trunk port must be
         reachable from the internet for inbound calls to arrive, which means
         it is reachable by scanners too — they find it within hours and send a
         continuous stream of INVITEs to guessed extensions. Without this list
         FreeSWITCH accepts SIP from any source. -->
    <list name="dialtone_trunk" default="deny">
      <node type="allow" cidr="185.73.43.0/24"/>   <!-- voips.modulus.gr -->
      <node type="allow" cidr="10.0.0.0/8"/>       <!-- carrier SBC, private -->
      <node type="allow" cidr="172.16.0.0/12"/>
      <node type="allow" cidr="192.168.0.0/16"/>
      <node type="allow" cidr="127.0.0.0/8"/>
      <node type="allow" cidr="100.64.0.0/10"/>    <!-- mesh VPN -->
    </list>

    <!-- Candidate addresses Dialtone may be reached on. 100.64.0.0/10 is
         CGNAT space, which mesh VPNs use and FreeSWITCH's wan.auto denies. -->
    <list name="dialtone_candidates" default="deny">
      <node type="allow" cidr="100.64.0.0/10"/>
      <node type="allow" cidr="192.168.0.0/16"/>
      <node type="allow" cidr="10.0.0.0/8"/>
      <node type="allow" cidr="172.16.0.0/12"/>
    </list>
'''
src = src.replace("<network-lists>", "<network-lists>" + acl, 1)
open(path, "w", encoding="utf-8").write(src)
PY
fi

# The parameter is `apply-candidate-acl`, NOT `candidate-acl`. mod_sofia
# ignores unknown params in silence, so the wrong spelling looks exactly like
# the right one: the ACL loads, the profile starts, and the same
# "NO candidate ACL defined" warning appears on every call. The stock
# autoload_configs/verto.conf.xml is where the correct name is written down.
sed -i '/<param name="candidate-acl"/d' "$I"
if ! grep -q 'apply-candidate-acl' "$I"; then
  sed -i 's|\( *\)<param name="rtp-ip" value="\$\${dialtone_bind_ip}"/>|\1<param name="rtp-ip" value="$${dialtone_bind_ip}"/>\n\1<param name="apply-candidate-acl" value="dialtone_candidates"/>\n\1<param name="apply-candidate-acl" value="localnet.auto"/>\n\1<param name="apply-candidate-acl" value="wan_v4.auto"/>|' "$I"
fi

# --- 3c. lock the trunk profile to the carrier ------------------------------

echo "== restricting who may send SIP to the trunk"
E="$CONF/sip_profiles/external.xml"
if ! grep -q 'apply-inbound-acl' "$E"; then
  sed -i '0,/<settings>/s|<settings>|<settings>
    <param name="apply-inbound-acl" value="dialtone_trunk"/>|' "$E"
fi

# The IPv6 profiles bind :5060 and :5080 on the Pi's global v6 address, which
# the Chronodesk instance already holds. Nothing here needs v6.
rm -f "$CONF/sip_profiles/internal-ipv6.xml" "$CONF/sip_profiles/external-ipv6.xml"
rm -rf "$CONF/sip_profiles/external-ipv6"

# --- 4. the softphone account ----------------------------------------------

echo "== installing the directory user"
cat > "$CONF/directory/default/1005.xml" <<'XML'
<include>
  <user id="1005">
    <params>
      <param name="password" value="$${dialtone_password}"/>
      <param name="vm-password" value="$${dialtone_password}"/>
    </params>
    <variables>
      <variable name="toll_allow" value="domestic,local,international"/>
      <variable name="accountcode" value="1005"/>
      <variable name="user_context" value="default"/>
      <variable name="effective_caller_id_name" value="Dialtone"/>
      <variable name="effective_caller_id_number" value="1005"/>
    </variables>
  </user>
</include>
XML

# --- 5. the landline gateway ------------------------------------------------
#
# Values come from dialtone_vars.xml, which this script creates with
# placeholders and never overwrites afterwards. Credentials are entered on
# this machine, by you, and are not in any repository.

echo "== installing the landline gateway"
cat > "$CONF/sip_profiles/external/landline.xml" <<'XML'
<include>
  <gateway name="landline">
    <param name="username" value="$${landline_username}"/>
    <param name="auth-username" value="$${landline_auth_username}"/>
    <param name="password" value="$${landline_password}"/>
    <param name="realm" value="$${landline_realm}"/>
    <param name="proxy" value="$${landline_proxy}"/>
    <param name="from-domain" value="$${landline_realm}"/>
    <!-- Modulus does not put the dialled number anywhere in the INVITE, so
         this param is the only thing that tells the dialplan which line was
         called. Without it the gateway reports the SIP username instead. -->
    <param name="extension" value="$${landline_did}"/>
    <param name="register" value="$${landline_register}"/>
    <param name="expire-seconds" value="600"/>
    <param name="retry-seconds" value="30"/>
    <!-- Home connections drop the NAT mapping long before registration
         expires; this keeps the pinhole open. -->
    <param name="ping" value="30"/>
    <param name="context" value="public"/>
    <param name="caller-id-in-from" value="true"/>
  </gateway>
</include>
XML

VARS="$CONF/vars/dialtone_vars.xml"
mkdir -p "$CONF/vars"
if [ ! -f "$VARS" ]; then
  echo "== creating $VARS (placeholders — fill these in)"
  cat > "$VARS" <<'XML'
<include>
  <!-- Dialtone's own extension password. Change it. -->
  <X-PRE-PROCESS cmd="set" data="dialtone_password=CHANGEME"/>

  <!-- Landline SIP account, from your provider. Until these are real, the
       gateway simply fails to register and nothing else is affected.
       Set landline_register=false to keep it from even trying. -->
  <X-PRE-PROCESS cmd="set" data="landline_register=false"/>
  <X-PRE-PROCESS cmd="set" data="landline_username=CHANGEME"/>
  <X-PRE-PROCESS cmd="set" data="landline_auth_username=CHANGEME"/>
  <X-PRE-PROCESS cmd="set" data="landline_password=CHANGEME"/>
  <X-PRE-PROCESS cmd="set" data="landline_realm=CHANGEME"/>
  <X-PRE-PROCESS cmd="set" data="landline_proxy=CHANGEME"/>
  <!-- The DID in E.164. Reported as the gateway's Exten, which is how the
       dialplan knows which line an inbound call arrived on. -->
  <X-PRE-PROCESS cmd="set" data="landline_did=CHANGEME"/>
</include>
XML
else
  echo "== keeping existing $VARS"
fi

# vars.xml must actually include it.
if ! grep -q 'vars/dialtone_vars.xml' "$V"; then
  sed -i 's|</include>|  <X-PRE-PROCESS cmd="include" data="vars/dialtone_vars.xml"/>\n</include>|' "$V"
fi

# --- 6. dialplan ------------------------------------------------------------
#
# Files under dialplan/default/ are included before the stock inline rules,
# so this is matched first.

echo "== installing the dialplan"
cat > "$CONF/dialplan/default/00_dialtone.xml" <<'XML'
<include>
  <!-- Outbound to the PSTN through the landline.

       Six digits or more, so it cannot shadow the internal extensions
       (1000-1019) or FreeSWITCH's own test numbers (9196 echo, 9197
       milliwatt, 9198 tone) — those stay reachable, and they are the fastest
       way to prove audio works without spending a call. -->
  <extension name="dialtone_outbound">
    <condition field="destination_number" expression="^(\+?\d{6,15})$">
      <action application="set" data="hangup_after_bridge=true"/>
      <action application="set" data="continue_on_fail=false"/>
      <action application="bridge" data="sofia/gateway/landline/$1"/>
    </condition>
  </extension>
</include>
XML

# The DID drives the inbound match. Derived here rather than hardcoded so the
# rule follows whatever number is configured; if the DID is still a
# placeholder, nothing is routed inbound, which is the safe default.
DID_RAW="$(sed -nE 's/.*landline_did=([^"]*)".*/\1/p' "$VARS" 2>/dev/null | head -1)"
NAT="${DID_RAW#+}"; NAT="${NAT#30}"
if [ -n "$NAT" ] && [ "$DID_RAW" != "CHANGEME" ]; then
  DID_PATTERN="^(\+?30)?${NAT}\$"
else
  DID_PATTERN="^\$a^"   # matches nothing
fi

cat > "$CONF/dialplan/public/00_dialtone_inbound.xml" <<'XML'
<include>
  <!-- Only this line's own number reaches the softphone.
       This once matched ^.*$, reasoning that the instance has one gateway and
       one user. That was wrong: `public` is where UNAUTHENTICATED internet SIP
       lands, not just trunk calls, so the catch-all gave every scanner on the
       internet a direct line to extension 1005 — thousands of calls a day.
       Anything that is not our DID now falls through unmatched and is answered
       with a 404, ringing nothing. -->
  <extension name="dialtone_inbound">
    <condition field="destination_number" expression="__DID_PATTERN__">
      <action application="set" data="domain_name=$${domain}"/>

      <!-- Pin the codecs offered TO the softphone.
           Without this, FreeSWITCH offers the browser whatever the inbound
           leg negotiated: L16/8000 from a loopback test, PCMU/PCMA from a
           real trunk. Chromium cannot do L16 at all, so it answers with only
           telephone-event and no audio codec, and FreeSWITCH hangs up with
           INCOMPATIBLE_DESTINATION — which reads like a signalling fault and
           is really a codec one.

           `nolocal:` matters: it applies the list to the leg being dialled
           and NOT to the inbound trunk leg, which must stay free to be
           G.711. -->
      <action application="export" data="nolocal:absolute_codec_string=opus,PCMU,PCMA"/>

      <action application="transfer" data="1005 XML default"/>
    </condition>
  </extension>
</include>
XML
sed -i "s|__DID_PATTERN__|${DID_PATTERN}|" "$CONF/dialplan/public/00_dialtone_inbound.xml"

# --- 7. a certificate for wss:// -------------------------------------------
#
# Optional: ws:// over the mesh is already inside an encrypted tunnel. This
# exists so wss://:7445 also works, and it is self-signed, so Dialtone will
# ask you to compare the fingerprint the first time.

# certs_dir is etc/freeswitch/tls — inside the config tree, NOT the
# `certs/` directory the name suggests. Ask FreeSWITCH rather than guessing:
#     fs_cli -x "global_getvar certs_dir"
CERTS="$CONF/tls"
mkdir -p "$CERTS"

if [ ! -f "$CERTS/wss.pem" ]; then
  echo "== generating a self-signed wss certificate"
  openssl req -x509 -newkey rsa:2048 -nodes -days 825 \
    -keyout "$CERTS/wss-key.pem" -out "$CERTS/wss-cert.pem" \
    -subj "/CN=$BIND_IP" -addext "subjectAltName=IP:$BIND_IP" 2>/dev/null
  # Certificate first, then key: the order sofia expects.
  cat "$CERTS/wss-cert.pem" "$CERTS/wss-key.pem" > "$CERTS/wss.pem"
  rm -f "$CERTS/wss-key.pem"
fi
echo -n "   wss fingerprint: "
openssl x509 -noout -fingerprint -sha256 -in "$CERTS/wss-cert.pem" | cut -d= -f2

# --- 7b. quieten modules that are not in this image ------------------------
#
# The stock module list asks for four modules the Chronodesk image does not
# build (spandsp was disabled deliberately; verto and signalwire need a libks
# that is not installed). Each one logs a CRIT at every start. They are not
# fatal, but a log full of CRIT is a log nobody reads, which is how the real
# error above went unnoticed for a run.
M="$CONF/autoload_configs/modules.conf.xml"
for mod in mod_verto mod_signalwire mod_spandsp mod_av; do
  sed -i "s|^\( *\)<load module=\"$mod\"/>|\1<!-- <load module=\"$mod\"/> not built in this image -->|" "$M"
done

# --- 7c. hand the tree to the container's uid ------------------------------
#
# Must be last: everything above edits these files as the current user.
echo "== handing config to uid 999 (the container's freeswitch user)"
sudo chown -R 999:999 "$CONF"
sudo chmod 600 "$CONF/vars/dialtone_vars.xml" "$CERTS/wss.pem"

# --- 8. run it --------------------------------------------------------------

echo "== (re)starting the container"
sudo docker rm -f "$NAME" >/dev/null 2>&1 || true
sudo docker run -d --name "$NAME" \
  --network host \
  --restart unless-stopped \
  -v "$CONF:/usr/local/freeswitch/etc/freeswitch" \
  "$IMAGE" >/dev/null

echo
echo "Waiting for it to come up…"

# -P 8022 on EVERY fs_cli, without exception.
#
# Both containers run with --network host, and fs_cli defaults to
# 127.0.0.1:8021 — which is Chronodesk's event socket. Without the port,
# `docker exec dialtone-freeswitch fs_cli ...` silently drives the OTHER
# FreeSWITCH: it reports its status, and it would execute its commands.
# During development this returned Chronodesk's profile list and made this
# instance look like it had started when it had not.
FS="sudo docker exec $NAME fs_cli -P 8022"

for _ in $(seq 1 30); do
  if $FS -x "status" >/dev/null 2>&1; then break; fi
  sleep 2
done

$FS -x "sofia status" || true

cat <<EOF

Point Dialtone at:

    WebSocket server   ws://$BIND_IP:5068
    Extension          1005
    SIP domain         $BIND_IP
    Password           whatever you set as dialtone_password

Then dial 9196 for an echo test — you should hear yourself. That proves
signalling, DTLS-SRTP and the audio path in one call, without touching the
PSTN.

Credentials live in (root-only, not in any repo):
    $VARS
After editing:
    sudo docker exec $NAME fs_cli -P 8022 -x reloadxml
    sudo docker exec $NAME fs_cli -P 8022 -x "sofia profile external restart"

Always pass -P 8022. Both containers share the host network, and fs_cli
without it talks to Chronodesk's FreeSWITCH on 8021 instead of this one.
EOF
