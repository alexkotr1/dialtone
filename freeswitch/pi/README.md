# The second FreeSWITCH on the Pi

`setup.sh` stands up a FreeSWITCH dedicated to Dialtone, alongside the one
Chronodesk uses, without touching it.

```bash
scp setup.sh alex@100.100.155.55:~/dialtone-fs-setup.sh
ssh alex@100.100.155.55 bash ~/dialtone-fs-setup.sh
```

Idempotent — re-running reapplies the config and replaces the container. It
never overwrites `conf/vars/dialtone_vars.xml`, which is where the credentials
live.

## What it does and does not touch

| | Chronodesk | Dialtone |
|---|---|---|
| container | `chronodesk-freeswitch` | `dialtone-freeswitch` |
| config | `/home/alex/freeswitch-conf` (individual file mounts) | `/home/alex/dialtone-fs/conf` (whole tree) |
| internal SIP | 5060 | **5062** |
| external SIP | 5080 | **5082** |
| ws / wss | 5066 / 7443 | **5068 / 7445** |
| event socket | 8021 | **8022** |
| RTP | 16384–32768 | **32769–40000** |
| binds to | 192.168.1.28 (LAN) | 100.100.155.55 (mesh) for the softphone |

Both use `--network host`, so the only shared resource is the port space —
which is why every port differs. The Chronodesk instance's config, container
and Modulus trunk are not modified by anything here.

## Two things that will waste your afternoon

**`fs_cli` defaults to port 8021 — which is Chronodesk's.** With host
networking, `docker exec dialtone-freeswitch fs_cli -x "sofia status"` reports
the *other* FreeSWITCH's profiles, and would execute commands against it.
Always:

```bash
sudo docker exec dialtone-freeswitch fs_cli -P 8022 -x "sofia status"
```

This is not cosmetic. During setup it made the new instance look like it had
started when it had in fact failed to start at all.

**The ICE candidate ACL silently drops mesh addresses.** With no
`apply-candidate-acl` set, FreeSWITCH defaults to `wan.auto`, which denies
`100.64.0.0/10` — carrier-grade NAT space, and exactly what NordVPN Meshnet,
Tailscale and friends hand out. The result:

- the SDP offer is fine, opus negotiates correctly
- FreeSWITCH logs `Save audio Candidate ... 100.115.196.227`
- …then discards it, has nothing left, waits out the ICE timer
- answers `488 Not Acceptable Here` after exactly 10 seconds
- **JsSIP reports this as "No common audio codec"**, which is the opposite of
  what happened — the debug log shows `Set Codec ... opus/48000` succeeding
  first

The tell is one warning line, visible only at debug level:

```
[WARNING] switch_core_media.c:4155 NO candidate ACL defined, Defaulting to wan.auto
```

The fix is a custom ACL allowing the mesh range. Note the parameter is
**`apply-candidate-acl`**, not `candidate-acl` — mod_sofia ignores unknown
parameters without complaint, so the wrong spelling behaves identically to
setting nothing at all. The correct name is written down in the stock
`autoload_configs/verto.conf.xml`.

## Checking it

```bash
FS="sudo docker exec dialtone-freeswitch fs_cli -P 8022"

$FS -x "sofia status"                          # internal on :5062, external on :5082
$FS -x "sofia status profile internal reg"     # 1005, once the app is running
$FS -x "sofia status gateway landline"         # REGED once credentials are in
```

Test numbers, which need no PSTN and cost nothing:

| | |
|---|---|
| `9196` | echo — proves the microphone path |
| `9197` | milliwatt, a 1004 Hz tone — proves the receive path |
| `9198` | tone stream |

The milliwatt test is the more useful of the two, because it has a known
answer: if what comes back is not ~1004 Hz, the audio path is wrong, and you
do not need an opinion about how it sounded.

## The landline

Not configured. `setup.sh` installs the gateway and creates
`conf/vars/dialtone_vars.xml` with placeholders; the credentials are yours to
enter on the Pi:

```bash
sudo nano /home/alex/dialtone-fs/conf/vars/dialtone_vars.xml
```

Set `landline_register=true` and the five `landline_*` values, then:

```bash
sudo docker exec dialtone-freeswitch fs_cli -P 8022 -x reloadxml
sudo docker exec dialtone-freeswitch fs_cli -P 8022 -x "sofia profile external restart"
sudo docker exec dialtone-freeswitch fs_cli -P 8022 -x "sofia status gateway landline"
```

Wait ~30 seconds before believing a `FAIL_WAIT`; the first REGISTER after a
profile restart commonly fails and succeeds on the retry.

Once it is `REGED`, dialling any number of six digits or more from Dialtone
goes out through it. Shorter numbers stay internal, so `1005` and the `919x`
test numbers keep working.

The file is `chmod 600`, owned by the container's uid, and is not in this
repository.

**What is actually in it now: the Modulus trunk.** The Chronodesk instance
never had `landline_*` values — its vars file defines `modulus_*`, the trunk
carrying the AI receptionist's DID. Those six values were copied across and
renamed (`modulus_did` becomes `landline_did`, which feeds the gateway's
`extension` param — the only thing that tells the dialplan which line an
inbound call arrived on, because Modulus does not put the dialled number
anywhere in the INVITE).

So "the landline" here is the same trunk Chronodesk uses, not a separate
line. See **Receiving calls** below for what that means in practice.

## Toll fraud, briefly

Once the landline registers, this box can place billable calls. It listens
only on the LAN and the mesh — nothing is port-forwarded — but the extension
password is the only thing between a device on those networks and your phone
bill. Use a long random one, and do not reuse the Chronodesk extension's.

## Receiving calls

Inbound works, and it needed two things beyond the gateway registering.

**The trunk has to be registered from this instance as well.** Set
`landline_register=true` in `conf/vars/dialtone_vars.xml`, reload, and restart
the external profile.

This is the same Modulus account Chronodesk uses, so the open question was
whether a second registration would displace the first. **It does not** —
verified: both gateways sit at `REGED` simultaneously and stayed there across
repeated checks, and Chronodesk's voice bridge kept running. Modulus's
registrar keeps a binding per Contact, the way a desk phone and a mobile on
one account both ring.

Which means **inbound calls to the DID now ring in both places**: the AI
receptionist and Dialtone. First to answer wins. That is a real change in
behaviour on that number, and it is the price of one DID serving two clients.
To make it exclusive again, unregister whichever side you do not want:

```bash
# Dialtone only ...
sudo sed -i 's/landline_register=true/landline_register=false/' \
  /home/alex/dialtone-fs/conf/vars/dialtone_vars.xml
sudo docker exec dialtone-freeswitch fs_cli -P 8022 -x reloadxml
sudo docker exec dialtone-freeswitch fs_cli -P 8022 -x "sofia profile external restart"
```

A second DID is the clean answer if both need to work independently.

**FreeSWITCH must be told which codecs to offer the browser.** Left alone it
offers the softphone whatever the *inbound* leg negotiated — `L16/8000` from
a loopback test, `PCMU`/`PCMA` from a real trunk. Chromium cannot do L16, so
it answers with `telephone-event` and no audio codec at all, and FreeSWITCH
hangs up with `INCOMPATIBLE_DESTINATION`. That reads like a signalling fault
and is entirely a codec one — DTLS and ICE were fine throughout.

The fix is one line in `dialplan/public/00_dialtone_inbound.xml`:

```xml
<action application="export" data="nolocal:absolute_codec_string=opus,PCMU,PCMA"/>
```

`nolocal:` is the important part — it pins the codec list on the leg being
dialled without forcing it on the inbound trunk leg, which has to stay free
to be G.711.

**Also disarm the stock password nag.** FreeSWITCH ships an extension that
matches every destination while `default_password` is still `1234`, logs four
CRIT lines and then `sleep(10000)`. It runs before any real rule, so inbound
calls connect to ten seconds of silence and then fail. `setup.sh` now
randomises that value.

### Testing inbound without spending a call

```bash
sudo docker exec dialtone-freeswitch fs_cli -P 8022 \
  -x "originate loopback/+302114443742/public 9197 XML default"
```

That injects a call into the `public` context with the DID as the
destination — the same shape a real trunk call takes — and bridges it to
milliwatt once the softphone answers. The app should ring, and answering
should give you a 1004 Hz tone.
