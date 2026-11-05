# Factorio: friend's VM setup checklist

Local note, not committed. For 2026-11-01. The design is in `factorio-agent.md` next to this file.

The friend's VM runs Oracle Linux 9 on aarch64 and already runs other software. Factorio will run there in Podman,
because the 2.1 ARM64 server needs glibc 2.38 and Oracle Linux 9 has 2.34. **Don't install Factorio by hand yet:**
the setup script will do it once the agent exists.

Step-by-step page to send him: the "Factorio Tailnet Setup" artifact,
https://claude.ai/artifact/KV5oQt4ApFEt3o2g6XarMo (private until shared from its page).
The API route and `ts.sh` below come from a research run on 2026-10-31 (the editor's Save hung twice); the page was rewritten as 13 linear steps the same day.

## Friend: tailnet

1. Sign up at https://login.tailscale.com (the free Personal plan is enough).
2. The friend follows the step-by-step page (13 steps, linear, no branches). The browser editor's Save hung twice
   ("Error validating grant: undefined", then a spinner): the browser got no usable reply from Tailscale's admin API.
   So the page saves the policy through the Tailscale API with `curl`, from the VM over its public SSH:
   - a 1-day API access token (revoked at the end);
   - `~/tailnet-policy/ts.sh`, a helper that prints `OK`/`NOT OK` for every call: `status` (which policy is live:
     NOT SAVED / STARTED / FINISHED), `check FILE` (`/acl/validate`), `save FILE` (GET for the ETag, then POST with
     `If-Match`), `devices`, `tag NODE_ID`, `noexpiry NODE_ID`, `selftest` (a test that must fail);
   - order: save `policy-start.json` (the grants below, no tests) → tag the VM `tag:factorio` and disable its key
     expiry (it joined untagged) → `tailscale set --ssh=false --shields-up=false ...` → Key 2 (`tag:orrery-hub`) to
     the owner → the owner joins the hub and sets firewalld → save `policy-final.hujson` (with the tests, now that
     both tags have devices) → `selftest` → link check → revoke the token.
   - Saving without tests first avoids an undocumented case: whether tests pass while no device has their tags.
   - The page's helper and files were tested against a fake API (scratchpad `page2/`), not the real one.
3. On 2026-10-31 the friend ran a save from the first API version of the page and the tailnet still showed the
   default policy. It had in fact saved: `sh ts.sh status` later showed the full policy (with tests) live, re-indented
   by Tailscale (hujson formatting, trailing commas), which the first `status` mistook for a different file; fixed.
   So a policy whose tests name tags with no devices yet **does save** (open question settled). The browser had
   simply not been reloaded. Next for the friend: step 7 (tag the VM) onwards.

The policy (grants, the form Tailscale recommends; grants-only files are deny-by-default, per the SaaS capture
`policytest-allpass-grants-only-tag-src-ip-literal-dst`. An `acls`-form copy with `"proto": "tcp"` is the fallback if `grants` is ever refused):

```json
{
  // Only the two tags below are used. Anything not granted here is blocked.
  "tagOwners": {
    "tag:factorio":   ["autogroup:admin"],
    "tag:orrery-hub": ["autogroup:admin"],
  },
  "grants": [
    // The orrery agent on the Factorio VM dials the hub: TCP 25584 only.
    {"src": ["tag:factorio"], "dst": ["tag:orrery-hub"], "ip": ["tcp:25584"]},
    // Your own devices may SSH (OpenSSH) to the Factorio VM.
    {"src": ["autogroup:member"], "dst": ["tag:factorio"], "ip": ["tcp:22"]},
  ],
  // A save is refused if any of these stops being true.
  "tests": [
    // The VM reaches the hub on TCP 25584 and on nothing else.
    {
      "src": "tag:factorio",
      "proto": "tcp",
      "accept": ["tag:orrery-hub:25584"],
      "deny": [
        "tag:orrery-hub:22",
        "tag:orrery-hub:80",
        "tag:orrery-hub:443",
        "tag:orrery-hub:25565",
        "tag:orrery-hub:25580",
        "tag:orrery-hub:25581",
        "tag:orrery-hub:25582",
      ],
    },
    {"src": "tag:factorio", "proto": "udp", "deny": ["tag:orrery-hub:25584"]},
    // The hub reaches nothing.
    {"src": "tag:orrery-hub", "proto": "tcp", "deny": ["tag:factorio:22", "tag:factorio:27015"]},
    {"src": "tag:orrery-hub", "proto": "udp", "deny": ["tag:factorio:34197"]},
  ],
}
```

## Friend: facts about his VM (send the output to the owner)

```sh
podman --version                   # setup needs 4.6+; older: he updates Podman himself first
uname -m                           # expect aarch64
ldd --version | head -1            # glibc version (expect 2.34)
ss -tulpn | grep -E ':(34197|34198|34199|27015) '   # want no output: ports free
nproc; free -g; df -h /            # CPU, RAM, disk for Factorio and saves
getenforce                         # SELinux mode
```

Also ask him:

- Does an OCI security list (or network security group) on his VM allow inbound UDP 34197? Players need it. If not,
  he adds an ingress rule.
- What other software runs on the VM? It matters for ports, memory and anything that uses Podman already.
- What are the Factorio names of the server admins? These go in `server-adminlist.json`: the owner and him, at least.

## Owner: hub host joins (after Key 2 arrives)

```sh
curl -fsSL https://tailscale.com/install.sh | sh
sudo systemctl enable --now tailscaled
sudo tailscale up --auth-key=PASTE_KEY_2 --hostname=orrery-hub --accept-dns=false

sudo firewall-cmd --permanent --new-zone=tailnet
sudo firewall-cmd --permanent --zone=tailnet --add-interface=tailscale0
sudo firewall-cmd --permanent --zone=tailnet \
  --add-rich-rule='rule family=ipv4 source address=VM_TAILNET_IP port port=25584 protocol=tcp accept'
sudo firewall-cmd --reload
sudo firewall-cmd --zone=tailnet --list-all   # ports: (none), services: (none), one rich rule
```

`VM_TAILNET_IP` is the VM's `100.x.y.z` address from his `tailscale status`. The design review changed this from
opening 25584/tcp to the whole zone, so only his VM is let in. If you already ran `--add-port=25584/tcp`, remove it:
`sudo firewall-cmd --permanent --zone=tailnet --remove-port=25584/tcp`.

Then record the hub's tailnet IP (`tailscale ip -4`). It goes in the hub's `integrations.agents.listen.host` and in the
agent's config.

## Both: check the link and the firewall

From his VM (`command -v nc || sudo dnf install -y nmap-ncat` first):

```sh
HUB=$(tailscale ip -4 orrery-hub); HUB6=$(tailscale ip -6 orrery-hub)
tailscale ping orrery-hub              # pong = the path works; it proves nothing about the policy
nc -zv -w3 "$HUB" 22                   # expect timeout (the tailnet policy drops it)
nc -zv -w3 "$HUB" 25580                # expect timeout
nc -zv -w3 "$HUB" 25581                # expect timeout
nc -zv -w3 "$HUB" 25584                # refused until the hub listens there; that's expected today
nc -6 -zv -w3 "$HUB6" 25584            # must not connect: the rich rule is IPv4-only
```

S13, firewalld on its own: the friend **temporarily** saves `s13-widened.hujson` (grant `"ip": ["*"]` from
`tag:factorio` to `tag:orrery-hub`, VM-to-hub deny tests removed). The owner lists every non-loopback listener
(`ss -tlnH`, `ss -ulnH`, including `[::]`), and starts `nc -lk <hub-ts-ip> 25584` if nothing listens there.
From the VM, every port over IPv4 and IPv6 must be blocked: a timeout, refused, "No route to host" (firewalld's
IPv4 reject) or "Permission denied" (its IPv6 reject). The one exception is 25584 over IPv4, which connects. The owner restarts `tailscaled` and the
scan is repeated. If any other port connects, Tailscale's netfilter rules are bypassing firewalld, and the design
must change (`--netfilter-mode=off` on the hub host). **The friend puts the policy back right after**, the same
three calls with `policy.hujson`, and runs the live tests again.

## Bring back to the design

- The outputs above (podman version, glibc, free ports, resources, SELinux mode, other software).
- The hub's tailnet IP and the VM's tailnet IP. The VM's IP is the agent's `address` in the hub config.
- Whether firewalld held with the tailnet policy opened (the test above).
- The admins' Factorio names.

## State on 2026-10-31 (evening)

- Tailnet policy: the final grants policy with tests is live (saved through the API; `status` says FINISHED).
- The VM `vnics-name` is tagged `tag:factorio`, tailnet IP **100.90.80.70** (`agents[].address`). Its tailscaled
  had been stopped for 22 h; starting it fixed "no such host" for `orrery-hub`.
- The hub host `orrery-hub` joined with `tag:orrery-hub`, tailnet IP **100.101.102.103**
  (`integrations.agents.listen.host`, and the agent's `hub.host`). Direct connection (`tailscale ping`, 1 ms).
- Hub firewalld: zone `tailnet` (active) holds `tailscale0`, no ports or services, one rich rule for
  100.90.80.70 → 25584/tcp. Before `tailscale0` was added to it, the VM got "No route to host" on 25584 (the
  default zone's reject), so firewalld does filter `tailscale0` (early evidence for S13, not the full scan).
- From the VM: port 22 times out (policy drop). 25584 should now answer "Connection refused" (nothing listens yet).
- Still to do: the friend's step 11 checks and step 13 (revoke the token); the VM facts list above; S13 after the
  hub listens on 25584.

## VM facts (from `~/vm-facts.sh`, 2026-10-31)

- Oracle Linux 9.8, kernel 6.12.0 UEK, aarch64, 4 × Neoverse-N1, 22 GB RAM (20 GB available), 4 GB swap,
  145 GB free on `/` (one volume: `/srv`, `/opt`, `/var` are on it). systemd 252. NTP synced. `/proc` without `hidepid`.
- glibc 2.34 (so the container stays). Podman 5.8.2, Quadlet present, `/etc/containers/systemd/` empty, no Podman
  containers or images (root or `opc`).
- Installed: podman, container-selinux 2.247, policycoreutils-python-utils, tar, xz, curl 7.76.1 (full, not
  curl-minimal). No system Node.
- SELinux enforcing (targeted).
- Ports 34197, 34198, 34199, 27015: free. No `factorio` user, unit or folder.
- firewalld active. Zones: `docker` (docker0 and two bridges), `public` (enp0s6) with services dhcpv6-client, http,
  https, ssh and ports 25565-25575 tcp/udp, 2456-2457/udp; forward yes. 34197/udp not open yet (setup step 16 adds it).
- **Docker runs on the VM** (dockerd, containerd), plus java (likely Minecraft, 25565-25575), Caddy, PCP (pmlogger),
  the OCI cloud and unified-monitoring agents (fluentd/ruby). The design didn't name Docker; it coexists: Factorio's
  container uses `Network=host`, Podman creates no networks, and setup never touches Docker.
- Tailscale 1.104.4: RunSSH false, ShieldsUp false, AdvertiseTags set, Hostname "" (name `vnics-name`). DNS is
  MagicDNS (`100.100.100.100`); orrery doesn't rely on it.
- Outbound HTTPS OK: factorio.com API and sha256sums, mods.factorio.com, nodejs.org, github.com, raw/objects
  githubusercontent, container-registry.oracle.com and registry-1.docker.io (401 = reachable).
- Hub port 25584 from the VM: Connection refused (the tailnet and firewalld path works; nothing listens yet).
- Open: OCI ingress for UDP 34197; the admins' Factorio names; what the Docker/Java services are; memory cap.
