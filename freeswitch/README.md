# Making FreeSWITCH accept Dialtone

Dialtone speaks **SIP over WebSocket with WebRTC media**, not plain SIP over
UDP. That is not a shortcut — it is the only transport a desktop app built on
Chromium can use, and it is what buys you Opus, echo cancellation and NAT
traversal without writing an RTP stack.

The consequence is that a FreeSWITCH which works perfectly with a desk phone
will still refuse Dialtone until three things are true.

---

## 1. The WebSocket ports are open

Stock `sip_profiles/internal.xml` ships these commented out or absent. Add
both inside `<settings>`:

```xml
<param name="ws-binding"  value=":5066"/>
<param name="wss-binding" value=":7443"/>
```

Then:

```bash
fs_cli -x "sofia profile internal restart"
fs_cli -x "sofia status"
```

You want to see `internal` listed with both bindings. If `wss-binding` is
missing from the output, FreeSWITCH could not load the certificate — see §3.

**These are not port 5060.** 5060 is plain SIP and Dialtone cannot use it.
The most common failure is putting `5060` in the app's server field and
concluding the app is broken.

## 2. There is a directory user to register as

Copy `dialtone-user.xml` to `/etc/freeswitch/directory/default/1005.xml`,
change the password, and `reloadxml`.

A **user** is not a **gateway**. If your FreeSWITCH is set up to register
outward to a carrier (Chronodesk's does exactly that), those gateway entries
do nothing for a softphone — it needs an inbound account of its own.

Check it exists:

```bash
fs_cli -x "user_exists id 1005 default"
```

## 3. TLS, if you use `wss://`

`wss://` needs `$${certs_dir}/wss.pem` — key and certificate concatenated
into one file. FreeSWITCH will silently skip `wss-binding` if it is missing.

**A real certificate** (Let's Encrypt or similar) just works:

```bash
cat privkey.pem fullchain.pem > /etc/freeswitch/tls/wss.pem
chown freeswitch:freeswitch /etc/freeswitch/tls/wss.pem
fs_cli -x "sofia profile internal restart"
```

**A self-signed certificate** also works, but Chromium refuses it by default.
Dialtone handles this: it shows you the host, the issuer and the SHA-256
fingerprint, and connects only if you accept. Compare the fingerprint against
the server before you do:

```bash
openssl x509 -noout -fingerprint -sha256 -in /etc/freeswitch/tls/wss.pem
```

The two strings should match character for character. The decision is stored
per host, and a certificate that later *changes* prompts again — which is the
prompt actually worth reading.

**Or skip TLS.** On a LAN, or across a VPN or tailnet that is already
encrypted, `ws://host:5066` is a legitimate choice and involves no
certificate at all. Do not do this across the open internet: SIP digest
credentials and the audio both travel in the clear.

## 4. If the media path crosses a NAT

Set a STUN server in Dialtone's settings (the default Google one is fine),
and make sure FreeSWITCH knows its own public address:

```xml
<param name="ext-rtp-ip" value="autonat:$${local_ip_v4}"/>
<param name="ext-sip-ip" value="autonat:$${local_ip_v4}"/>
```

Symptom of getting this wrong: the call connects, the timer runs, and nobody
hears anything. Signalling is working and media is not.

---

## Checking it end to end

```bash
# 1. Is the port even listening?
ss -lntp | grep -E '5066|7443'

# 2. Watch the registration attempt as it happens
fs_cli -x "sofia global siptrace on"
fs_cli -x "console loglevel debug"

# 3. After connecting from Dialtone
fs_cli -x "sofia status profile internal reg"
```

That last command showing your extension is the proof. Everything before it
is a guess.

## What each failure looks like in the app

| In Dialtone | Almost always means |
|---|---|
| "No response from wss://…" | Wrong port, firewall, or `wss-binding` never loaded |
| "Untrusted certificate" | Self-signed cert — compare the fingerprint and accept |
| "Authentication failed" | Wrong password, or the user is in a different domain |
| Registered, but calls fail with "No common audio codec" | FreeSWITCH is not offering Opus/PCMU to the WebRTC leg |
| Registered, call connects, silence | NAT — see §4 |

## A note on Chronodesk's FreeSWITCH

If you point this at the Pi, none of the above is set up there: that box has
carrier **gateways** and no WebSocket binding, no directory user, and no
`wss.pem`. It would all need adding, and doing so touches a config that is
currently carrying real calls. A separate FreeSWITCH is the safer way to try
this.
